/**
 * Turn a session's history (`GET /api/sessions/:id`) into `useChat` messages.
 *
 * An assistant message arrives as the UI message stream parts the server
 * made from its run. They go through `readUIMessageStream`, the same AI SDK
 * code a live turn goes through, so a reloaded chat renders like the live one.
 *
 * @module chat/history
 */

import { readUIMessageStream, type UIMessageChunk } from "ai"
import type { ChatDataTypes, ChatMessage, HistoryMessage } from "@/api/types.ts"

/** A history message after decoding, with what the decode reported. */
export interface DecodedMessage {
  message: ChatMessage
  /** `error` parts of the run, in order. */
  errors: string[]
  /** The run had not finished when the history was read. */
  running: boolean
}

async function decodeAssistant(
  id: string,
  chunks: UIMessageChunk<unknown, ChatDataTypes>[],
): Promise<{ message: ChatMessage; errors: string[] }> {
  const errors: string[] = []
  const stream = new ReadableStream<UIMessageChunk<unknown, ChatDataTypes>>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  let message: ChatMessage = { id, role: "assistant", parts: [] }
  for await (const snapshot of readUIMessageStream<ChatMessage>({
    stream,
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  })) {
    message = snapshot
  }
  return { message, errors }
}

/** Decode the whole history, in order. */
export async function decodeHistory(history: HistoryMessage[]): Promise<DecodedMessage[]> {
  const out: DecodedMessage[] = []
  for (const item of history) {
    if (item.role === "user") {
      out.push({
        message: { id: item.id, role: "user", parts: [{ type: "text", text: item.text }] },
        errors: [],
        running: false,
      })
      continue
    }
    const { message, errors } = await decodeAssistant(item.id, item.chunks)
    out.push({ message, errors, running: item.running })
  }
  return out
}
