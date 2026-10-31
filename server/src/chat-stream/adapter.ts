/**
 * Chat stream adapter (spec 4.3, S54): core events in, UI message stream parts out.
 *
 * {@link mapChatStreamInput} is a pure reducer. It takes the adapter state and
 * one input, and returns the next state and the parts to send. The server folds
 * every event of a run through it; `sse.ts` turns the parts into SSE text.
 *
 * Mapping (spec 4.3):
 *
 * | Core                      | UI message stream                                  |
 * | ------------------------- | -------------------------------------------------- |
 * | run start                 | `start`                                            |
 * | `turn_started`            | `start-step`                                       |
 * | `turn_completed`          | `data-usage`, then `finish-step`                   |
 * | `text_delta`              | `text-start` (first delta), `text-delta`           |
 * | `thinking_delta`          | `reasoning-start` (first delta), `reasoning-delta` |
 * | `item_completed` text     | `text-end`                                         |
 * | `item_completed` thinking | `reasoning-end`                                    |
 * | `item_completed` tool_use | `tool-input-available`                             |
 * | `tool_result`             | `tool-output-available`                            |
 * | `notice`                  | `data-notice`                                      |
 * | `error`                   | `error` (`errorText`)                              |
 * | run end                   | `finish` (then `data: [DONE]`, added by `sse.ts`)  |
 *
 * Today's core (the nine `AgentEvent` kinds) has no run start or run end
 * event, so the host sends `run_started` and `run_ended` itself. Core phase 3
 * adds `run_finished`, `tool_call`, `tool_output`, `status`, `ask_user`,
 * `quota`, and `user_message`. Each one is a new case in the switch in
 * {@link mapAgentEvent}. That switch ends in a `never` check, so a new core
 * kind fails typecheck until it is mapped here.
 *
 * Deltas are opt-in in core (`emitDeltas`). Without them, `item_completed`
 * carries the whole text, and the adapter sends start, delta, and end at
 * once. With them, the deltas carry the text and `item_completed` only ends
 * the part. A consumer uses one or the other, never both (see core's
 * `TextDeltaEvent` docs).
 *
 * Core does not put tool input or tool output in today's events. So
 * `tool-input-available` has `input: null`, and `tool-output-available` has
 * the facts `tool_result` carries (`{ isError }`). Phase 3 adds them
 * (`tool_call.inputSummary`, `tool_result.outputSummary`).
 *
 * @module chat-stream/adapter
 */

import type { AgentEvent, TurnCompletedEvent } from "@minimal-agent/core/sdk/events"

import type { UiFinishReason, UiMessageChunk } from "./chunks.ts"

/** Core's canonical stop reason, as `turn_completed` reports it. */
type StopReason = NonNullable<TurnCompletedEvent["stopReason"]>

/** One input to the adapter: a core event, or a run boundary from the host. */
export type ChatStreamInput =
  | { kind: "run_started"; messageId?: string }
  | { kind: "event"; event: AgentEvent }
  | { kind: "run_ended" }

/** The adapter state between inputs. Treat it as opaque. */
export interface ChatStreamState {
  /** `start` was sent. */
  readonly started: boolean
  /** `finish` was sent. Later inputs produce no parts. */
  readonly finished: boolean
  /** A `start-step` is open. */
  readonly stepOpen: boolean
  /** Id of the open text part, if any. */
  readonly openText: string | null
  /** Id of the open reasoning part, if any. */
  readonly openReasoning: string | null
  /** The current step had `text_delta` events. */
  readonly streamedText: boolean
  /** The current step had `thinking_delta` events. */
  readonly streamedReasoning: boolean
  /** Stop reason of the last completed turn, or `undefined` if none completed. */
  readonly lastStopReason: StopReason | null | undefined
  /** An `error` event arrived. */
  readonly errored: boolean
}

/** The state before the first input. */
export const INITIAL_CHAT_STREAM_STATE: ChatStreamState = {
  started: false,
  finished: false,
  stepOpen: false,
  openText: null,
  openReasoning: null,
  streamedText: false,
  streamedReasoning: false,
  lastStopReason: undefined,
  errored: false,
}

/** What one reducer step returns. */
export interface ChatStreamStep {
  state: ChatStreamState
  chunks: UiMessageChunk[]
}

type Draft = { -readonly [K in keyof ChatStreamState]: ChatStreamState[K] }

/**
 * Map one input to the UI message stream parts it produces.
 *
 * Pure: it does not change `state`. The returned parts always form a valid
 * stream: `start` comes first, text and reasoning parts open before their
 * deltas and close before their step ends, and nothing follows `finish`.
 */
export function mapChatStreamInput(state: ChatStreamState, input: ChatStreamInput): ChatStreamStep {
  if (state.finished) return { state, chunks: [] }
  const draft: Draft = { ...state }
  const chunks: UiMessageChunk[] = []
  if (!draft.started) {
    draft.started = true
    chunks.push(
      input.kind === "run_started" && input.messageId !== undefined
        ? { type: "start", messageId: input.messageId }
        : { type: "start" },
    )
  }
  switch (input.kind) {
    case "run_started":
      break
    case "event":
      mapAgentEvent(draft, input.event, chunks)
      break
    case "run_ended":
      endRun(draft, chunks)
      break
    default:
      unmapped(input)
  }
  return { state: draft, chunks }
}

/** Map one core event. One case per `AgentEvent` kind. */
function mapAgentEvent(draft: Draft, event: AgentEvent, chunks: UiMessageChunk[]): void {
  switch (event.type) {
    case "turn_started":
      endStep(draft, chunks)
      draft.lastStopReason = undefined
      chunks.push({ type: "start-step" })
      draft.stepOpen = true
      return
    case "text_delta":
      openStep(draft, chunks)
      if (draft.openText !== event.id) {
        closeText(draft, chunks)
        chunks.push({ type: "text-start", id: event.id })
        draft.openText = event.id
      }
      chunks.push({ type: "text-delta", id: event.id, delta: event.text })
      draft.streamedText = true
      return
    case "thinking_delta":
      openStep(draft, chunks)
      if (draft.openReasoning !== event.id) {
        closeReasoning(draft, chunks)
        chunks.push({ type: "reasoning-start", id: event.id })
        draft.openReasoning = event.id
      }
      chunks.push({ type: "reasoning-delta", id: event.id, delta: event.text })
      draft.streamedReasoning = true
      return
    case "item_started":
      // The matching item_completed carries everything this event does.
      return
    case "item_completed":
      openStep(draft, chunks)
      mapItemCompleted(draft, event, chunks)
      return
    case "tool_result":
      openStep(draft, chunks)
      chunks.push({
        type: "tool-output-available",
        toolCallId: event.id,
        output: { isError: event.isError },
        dynamic: true,
      })
      return
    case "turn_completed":
      openStep(draft, chunks)
      closeText(draft, chunks)
      closeReasoning(draft, chunks)
      chunks.push({
        type: "data-usage",
        data: { kind: "turn", turn: event.turn, usage: event.usage },
      })
      endStep(draft, chunks)
      draft.lastStopReason = event.stopReason
      return
    case "notice":
      chunks.push({ type: "data-notice", data: event.notice })
      return
    case "error":
      closeText(draft, chunks)
      closeReasoning(draft, chunks)
      chunks.push({ type: "error", errorText: errorText(event.message, event.hint) })
      draft.errored = true
      return
    default:
      unmapped(event)
  }
}

type ItemCompleted = Extract<AgentEvent, { type: "item_completed" }>

function mapItemCompleted(draft: Draft, event: ItemCompleted, chunks: UiMessageChunk[]): void {
  switch (event.itemType) {
    case "text":
      if (draft.streamedText) {
        // The deltas already carried the text. The first text item ends them.
        closeText(draft, chunks)
        return
      }
      chunks.push({ type: "text-start", id: event.id })
      if (event.text) chunks.push({ type: "text-delta", id: event.id, delta: event.text })
      chunks.push({ type: "text-end", id: event.id })
      return
    case "thinking":
      if (draft.streamedReasoning) {
        closeReasoning(draft, chunks)
        return
      }
      chunks.push({ type: "reasoning-start", id: event.id })
      if (event.text) chunks.push({ type: "reasoning-delta", id: event.id, delta: event.text })
      chunks.push({ type: "reasoning-end", id: event.id })
      return
    case "tool_use":
      // For a tool_use item, core puts the tool name in `text`.
      chunks.push({
        type: "tool-input-available",
        toolCallId: event.id,
        toolName: event.text ?? "",
        input: null,
        dynamic: true,
      })
      return
    default:
      unmapped(event.itemType)
  }
}

function openStep(draft: Draft, chunks: UiMessageChunk[]): void {
  if (draft.stepOpen) return
  chunks.push({ type: "start-step" })
  draft.stepOpen = true
}

function endStep(draft: Draft, chunks: UiMessageChunk[]): void {
  closeText(draft, chunks)
  closeReasoning(draft, chunks)
  if (draft.stepOpen) chunks.push({ type: "finish-step" })
  draft.stepOpen = false
  draft.streamedText = false
  draft.streamedReasoning = false
}

function closeText(draft: Draft, chunks: UiMessageChunk[]): void {
  if (draft.openText === null) return
  chunks.push({ type: "text-end", id: draft.openText })
  draft.openText = null
}

function closeReasoning(draft: Draft, chunks: UiMessageChunk[]): void {
  if (draft.openReasoning === null) return
  chunks.push({ type: "reasoning-end", id: draft.openReasoning })
  draft.openReasoning = null
}

function endRun(draft: Draft, chunks: UiMessageChunk[]): void {
  endStep(draft, chunks)
  const finishReason = draft.errored ? "error" : toFinishReason(draft.lastStopReason)
  chunks.push(finishReason === undefined ? { type: "finish" } : { type: "finish", finishReason })
  draft.finished = true
}

function errorText(message: string, hint: string | undefined): string {
  return hint ? `${message}\n${hint}` : message
}

/** Map core's stop reason to the protocol's finish reason. */
export function toFinishReason(
  stopReason: StopReason | null | undefined,
): UiFinishReason | undefined {
  if (stopReason === undefined) return undefined
  if (stopReason === null) return "other"
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "tool_use":
      return "tool-calls"
    case "max_tokens":
    case "context_window_exceeded":
      return "length"
    case "refusal":
    case "content_filter":
      return "content-filter"
    case "pause_turn":
      return "other"
    case "error":
      return "error"
    default:
      unmapped(stopReason)
      return "other"
  }
}

/**
 * The `never` check that ends each switch. A new core kind makes the call a
 * type error until it is mapped. At runtime an unknown value maps to nothing,
 * so a live stream keeps going.
 */
function unmapped(_value: never): void {}
