/**
 * SSE encoding of the chat stream (spec 4.3, D24).
 *
 * The wire format matches the AI SDK UI message stream protocol: one
 * `data: <json>` event per part, then `data: [DONE]` after `finish`. It is
 * the same text the AI SDK's `JsonToSseTransformStream` writes, produced here
 * without the AI SDK.
 *
 * @module chat-stream/sse
 */

import {
  type ChatStreamInput,
  type ChatStreamState,
  INITIAL_CHAT_STREAM_STATE,
  mapChatStreamInput,
} from "./adapter.ts"
import type { UiMessageChunk } from "./chunks.ts"

/** The SSE event that ends the stream. */
export const SSE_DONE = "data: [DONE]\n\n"

/** Encode one part as one SSE event. */
export function encodeSseChunk(chunk: UiMessageChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * A stateful wrapper around the pure adapter for one run: push inputs, get
 * SSE text. After `finish` it adds {@link SSE_DONE} and then returns "".
 */
export class ChatStreamEncoder {
  private state: ChatStreamState = INITIAL_CHAT_STREAM_STATE

  /** Map one input and return its SSE text (may be empty). */
  push(input: ChatStreamInput): string {
    const step = mapChatStreamInput(this.state, input)
    this.state = step.state
    const text = step.chunks.map(encodeSseChunk).join("")
    return step.state.finished && step.chunks.length > 0 ? text + SSE_DONE : text
  }

  /** End the run if the inputs did not: closes open parts, then `finish` and `[DONE]`. */
  end(): string {
    return this.push({ kind: "run_ended" })
  }
}

/** Encode a whole run to SSE text. The run ends after the last input. */
export function encodeChatStream(inputs: Iterable<ChatStreamInput>): string {
  const encoder = new ChatStreamEncoder()
  let text = ""
  for (const input of inputs) text += encoder.push(input)
  return text + encoder.end()
}
