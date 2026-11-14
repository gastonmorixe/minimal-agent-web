/**
 * Chat stream adapter (spec 4.3, S54, updated for S53): core events in, UI
 * message stream parts out.
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
 * | `retry-boundary`          | `text-delta` with the stall marker text            |
 * | `thinking_delta`          | `reasoning-start` (first delta), `reasoning-delta` |
 * | `item_completed` text     | `text-end`                                         |
 * | `item_completed` thinking | `reasoning-end`                                    |
 * | `item_completed` tool_use | `tool-input-available` (`input: null`)             |
 * | `tool_call`               | `tool-input-available` (real `input`)              |
 * | `tool_output`             | `tool-output-available` (`preliminary: true`)      |
 * | `tool_result`             | `tool-output-available` or `tool-output-error`     |
 * | `ask_user`                | `data-ask-user`                                    |
 * | `status`                  | `data-status` (transient)                          |
 * | `quota`                   | `data-usage` (`kind: "quota"`)                     |
 * | `user_message`            | nothing (the client already has it)                |
 * | `block_started`           | nothing (the first delta opens the part)           |
 * | `block_stopped`           | nothing (`item_completed` closes the part)         |
 * | `notice`                  | `data-notice`                                      |
 * | `error`                   | `error` (`errorText`)                              |
 * | `run_finished`, run end   | `finish` (then `data: [DONE]`, added by `sse.ts`)  |
 *
 * Core has no run start or run end event, so the host sends `run_started`
 * and `run_ended` itself (`run_finished` ends the UI message at `finish`,
 * but the host still needs `run_started` for cases that start the stream
 * before the first core event, e.g. an empty history replay). The switch in
 * {@link mapAgentEvent} ends in a `never` check, so a new `AgentEvent` kind
 * fails typecheck here until it is mapped.
 *
 * Tool parts: the part opens at the first event that names the call
 * (`item_completed` tool_use, or `tool_call` if that arrives first). `ask_user`
 * is NOT a tool-approval request — core has no tool-approval concept at all
 * (see `backend/runtime-backend.ts`'s "no tools" scope note: today's sessions
 * never produce `tool_call` / `tool_output` / `tool_result` in the first
 * place). It is a preflight multiple-choice question, mapped to a plain
 * `data-ask-user` part; there is no "answered" event from core, so the part
 * always carries `options` and the client marks it answered itself. `tool_output`
 * text accumulates per call (capped at {@link TOOL_TEXT_CAP} characters) and is
 * sent as a preliminary output.
 *
 * Deltas are opt-in in core (`emitDeltas`). Without them, `item_completed`
 * carries the whole text, and the adapter sends start, delta, and end at
 * once. With them, the deltas carry the text and `item_completed` only ends
 * the part. A consumer uses one or the other, never both (see core's
 * `TextDeltaEvent` docs).
 *
 * @module chat-stream/adapter
 */

import type { AgentEvent, TurnCompletedEvent } from "@minimal-agent/core/sdk/events"

import type { UiFinishReason, UiMessageChunk } from "./chunks.ts"

/** Core's canonical stop reason, as `turn_completed` reports it. */
type StopReason = NonNullable<TurnCompletedEvent["stopReason"]>

/** Core's run outcome, as `run_finished` reports it. */
type RunOutcome = Extract<AgentEvent, { type: "run_finished" }>["outcome"]

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
  /** Tool calls with an open tool part, and their tool names. */
  readonly tools: Readonly<Record<string, string>>
  /** `tool_output` text so far, by call id. */
  readonly toolText: Readonly<Record<string, string>>
  /** The outcome from `run_finished`, if it arrived. */
  readonly outcome: RunOutcome | undefined
}

/** Most `tool_output` characters kept per call. Later text is dropped and the output marked truncated. */
export const TOOL_TEXT_CAP = 64 * 1024

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
  tools: {},
  toolText: {},
  outcome: undefined,
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
      textDelta(draft, chunks, event.id, event.text)
      return
    case "retry-boundary":
      // S14.4: core sends the boundary as data. The text part gets the marker
      // text that core used to stream, so the browser shows the same bytes.
      textDelta(draft, chunks, event.id, retryBoundaryText(event.attempt))
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
    case "block_started":
    case "block_stopped":
      // The first delta of a block already opens its part, and item_completed
      // closes it. A part opened or closed here too would be sent twice.
      return
    case "item_completed":
      openStep(draft, chunks)
      mapItemCompleted(draft, event, chunks)
      return
    case "tool_call":
      openStep(draft, chunks)
      openTool(draft, event.callId, event.toolName)
      chunks.push({
        type: "tool-input-available",
        toolCallId: event.callId,
        toolName: event.toolName,
        input: event.input,
        dynamic: true,
      })
      return
    case "tool_output":
      openStep(draft, chunks)
      ensureTool(draft, chunks, event.callId, event.toolName)
      chunks.push({
        type: "tool-output-available",
        toolCallId: event.callId,
        output: appendToolText(draft, event.callId, event.text, event.truncated, event.totalBytes),
        dynamic: true,
        preliminary: true,
      })
      return
    case "tool_result":
      openStep(draft, chunks)
      ensureTool(draft, chunks, event.id, event.name)
      chunks.push(toolResultChunk(draft, event))
      return
    case "ask_user":
      openStep(draft, chunks)
      chunks.push({
        type: "data-ask-user",
        id: event.askId,
        data: {
          askId: event.askId,
          code: event.code,
          title: event.title,
          detail: event.detail,
          options: event.options,
        },
      })
      return
    case "status": {
      const { type: _type, ...data } = event
      chunks.push({ type: "data-status", data, transient: true })
      return
    }
    case "quota": {
      const { type: _type, ...rest } = event
      chunks.push({
        type: "data-usage",
        id: `quota:${event.provider}`,
        data: { kind: "quota", ...rest },
      })
      return
    }
    case "user_message":
      // The client sent this text itself. History replays add it as a user message.
      return
    case "run_finished":
      draft.outcome = event.outcome
      endRun(draft, chunks)
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

/** Send one text delta, and open the text part for `id` first if it is not open. */
function textDelta(draft: Draft, chunks: UiMessageChunk[], id: string, text: string): void {
  openStep(draft, chunks)
  if (draft.openText !== id) {
    closeText(draft, chunks)
    chunks.push({ type: "text-start", id })
    draft.openText = id
  }
  chunks.push({ type: "text-delta", id, delta: text })
  draft.streamedText = true
}

/** The text of a `retry-boundary` event: the stall marker core used to stream. */
export function retryBoundaryText(attempt: number): string {
  return `\n↳ stream stalled — retrying (attempt ${attempt})…\n`
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
    case "tool_use": {
      // For a tool_use item, core puts the tool name in `text`.
      const toolName = event.text ?? ""
      openTool(draft, event.id, toolName)
      chunks.push({
        type: "tool-input-available",
        toolCallId: event.id,
        toolName,
        input: null,
        dynamic: true,
      })
      return
    }
    default:
      unmapped(event.itemType)
  }
}

/** Record that the part for `callId` is open, with its tool name. */
function openTool(draft: Draft, callId: string, toolName: string): void {
  if (draft.tools[callId] !== toolName) draft.tools = { ...draft.tools, [callId]: toolName }
}

/** Open the tool part for `callId` if no event named the call yet. */
function ensureTool(
  draft: Draft,
  chunks: UiMessageChunk[],
  callId: string,
  toolName: string,
): void {
  if (draft.tools[callId] !== undefined) return
  openTool(draft, callId, toolName)
  chunks.push({
    type: "tool-input-available",
    toolCallId: callId,
    toolName,
    input: null,
    dynamic: true,
  })
}

interface ToolTextOutput {
  text: string
  truncated: boolean
  totalBytes: number
}

function appendToolText(
  draft: Draft,
  callId: string,
  text: string,
  truncated: boolean,
  totalBytes: number,
): ToolTextOutput {
  const before = draft.toolText[callId] ?? ""
  const joined = before + text
  const capped = joined.length > TOOL_TEXT_CAP
  const kept = capped ? joined.slice(0, TOOL_TEXT_CAP) : joined
  draft.toolText = { ...draft.toolText, [callId]: kept }
  return { text: kept, truncated: truncated || capped, totalBytes }
}

type ToolResult = Extract<AgentEvent, { type: "tool_result" }>

/** The final chunk of a tool call: its output, or its error. */
function toolResultChunk(draft: Draft, event: ToolResult): UiMessageChunk {
  if (event.isError) {
    return {
      type: "tool-output-error",
      toolCallId: event.id,
      errorText: event.outputSummary ?? "The tool reported an error.",
      dynamic: true,
    }
  }
  const text = draft.toolText[event.id]
  return {
    type: "tool-output-available",
    toolCallId: event.id,
    output: {
      isError: false,
      ...(event.outputSummary === undefined ? {} : { summary: event.outputSummary }),
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(text === undefined ? {} : { text }),
    },
    dynamic: true,
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
  const finishReason = draft.errored ? "error" : outcomeFinishReason(draft)
  chunks.push(finishReason === undefined ? { type: "finish" } : { type: "finish", finishReason })
  draft.finished = true
}

/** The finish reason for the run's outcome. Without `run_finished`, the last stop reason decides. */
function outcomeFinishReason(draft: Draft): UiFinishReason | undefined {
  switch (draft.outcome) {
    case undefined:
    case "completed":
      return toFinishReason(draft.lastStopReason)
    case "truncated":
      return "length"
    case "failed":
      return "error"
    case "aborted":
    case "waiting":
      return "other"
    default:
      unmapped(draft.outcome)
      return "other"
  }
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
