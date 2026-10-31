/**
 * A session's chat history, rebuilt from its event log.
 *
 * `GET /api/sessions/:id` returns the history as messages. A user message is
 * its text. An assistant message is the UI message stream parts the chat
 * stream adapter makes from that run's events, so the client decodes the
 * history with the same AI SDK code path as a live turn, and a reloaded chat
 * looks like the live one.
 *
 * Runs: a run starts at its `user_message` entry (or, without one, at the
 * first event after the previous run) and ends at its `run_finished`. A
 * `user_message` also ends a run that is still open. The assistant message
 * of a run has the id `msg-<seq of the run's first entry>`, and a backend
 * uses the same id for the live stream ({@link assistantMessageId}).
 *
 * @module backend/history
 */

import {
  type ChatStreamInput,
  type ChatStreamState,
  INITIAL_CHAT_STREAM_STATE,
  mapChatStreamInput,
} from "../chat-stream/adapter.ts"
import type { UiMessageChunk } from "../chat-stream/chunks.ts"
import type { SessionEntry } from "../core-mirror/session-entry.ts"

/** One message of the history. */
export type HistoryMessage =
  | { id: string; role: "user"; text: string }
  | {
      id: string
      role: "assistant"
      /** The run's UI message stream parts, from `start`. */
      chunks: UiMessageChunk[]
      /** The run has not finished yet. */
      running: boolean
    }

/** Id of the assistant message for the run that starts at `seq`. */
export function assistantMessageId(seq: number): string {
  return `msg-${seq}`
}

/** Id of the user message logged at `seq`. */
export function userMessageId(seq: number): string {
  return `user-${seq}`
}

interface OpenRun {
  message: Extract<HistoryMessage, { role: "assistant" }>
  state: ChatStreamState
}

function feed(run: OpenRun, input: ChatStreamInput): void {
  const step = mapChatStreamInput(run.state, input)
  run.state = step.state
  run.message.chunks.push(...step.chunks)
  if (step.state.finished) run.message.running = false
}

function openRun(messages: HistoryMessage[], seq: number): OpenRun {
  const message: OpenRun["message"] = {
    id: assistantMessageId(seq),
    role: "assistant",
    chunks: [],
    running: true,
  }
  messages.push(message)
  const run: OpenRun = { message, state: INITIAL_CHAT_STREAM_STATE }
  feed(run, { kind: "run_started", messageId: message.id })
  return run
}

/** Rebuild the chat history from a whole event log, oldest entry first. */
export function historyFromEntries(entries: Iterable<SessionEntry>): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  let run: OpenRun | null = null
  for (const entry of entries) {
    if (entry.ch !== "event") continue
    const event = entry.data
    if (event.type === "user_message") {
      if (run !== null) feed(run, { kind: "run_ended" })
      messages.push({ id: userMessageId(entry.seq), role: "user", text: event.text })
      run = openRun(messages, entry.seq)
      continue
    }
    run ??= openRun(messages, entry.seq)
    feed(run, { kind: "event", event })
    if (event.type === "run_finished") run = null
  }
  return messages
}
