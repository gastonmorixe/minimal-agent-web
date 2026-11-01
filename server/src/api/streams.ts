/**
 * The two streaming answers of the API: the chat stream of one turn and the
 * session event log. Both are SSE and send a `: keep-alive` comment while
 * idle, so a turn that waits for an answer or a quota reset keeps its
 * connection. SSE clients (and the AI SDK's parser) ignore comment lines.
 *
 * @module api/streams
 */

import { type SessionEntry, serializeEntrySse } from "@minimal-agent/core"

import type { SessionBackend, TurnHandle } from "../backend/backend.ts"
import { UI_MESSAGE_STREAM_HEADERS } from "../chat-stream/chunks.ts"
import { ChatStreamEncoder, encodeSseChunk } from "../chat-stream/sse.ts"

import { INTERNAL_ERROR, logInternalError } from "./internal-error.ts"

/** Options the streams share. */
export interface StreamOptions {
  /** Time between keep-alive comments. */
  keepAliveMs: number
}

/** Response headers of the event log stream. */
export const EVENT_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const

const KEEP_ALIVE = ": keep-alive\n\n"

/** A stream writer that stops quietly once the stream is closed or cancelled. */
class SseWriter {
  private readonly encoder = new TextEncoder()
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    keepAliveMs: number,
    private readonly onClose: () => void,
  ) {
    this.timer = setInterval(() => this.write(KEEP_ALIVE), keepAliveMs)
  }

  write(text: string): void {
    if (this.closed || text.length === 0) return
    try {
      this.controller.enqueue(this.encoder.encode(text))
    } catch {
      // The underlying connection can die between a dropped client and this
      // writer's own `cancel`/`abort` handler running (both async): treat a
      // write to a controller Bun already tore down the same as `stop()`.
      this.stop()
    }
  }

  close(): void {
    if (this.closed) return
    this.stop()
    try {
      this.controller.close()
    } catch {
      // Already torn down from the other side; nothing left to close.
    }
  }

  /** Stop without closing the controller: the consumer went away. */
  stop(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.onClose()
  }
}

/** The text of the generic error part: no message, no stack. */
function internalErrorText(requestId: string): string {
  return `${INTERNAL_ERROR} (request ${requestId})`
}

/**
 * Stream one turn as an AI SDK UI message stream (spec 4.3). The response
 * ends after `finish` and `[DONE]`. When the client goes away the stream
 * stops reading, and the run goes on in the backend.
 */
export function chatStreamResponse(turn: TurnHandle, options: StreamOptions): Response {
  const chat = new ChatStreamEncoder()
  const events = turn.events[Symbol.asyncIterator]()
  let writer: SseWriter | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = new SseWriter(controller, options.keepAliveMs, () => {
        void events.return?.()
      })
      writer.write(chat.push({ kind: "run_started", messageId: turn.messageId }))
    },
    async pull() {
      // A pull that enqueues nothing is not called again (WHATWG streams),
      // so read until an event produces parts or the run ends.
      try {
        for (;;) {
          const next = await events.next()
          if (next.done) {
            writer?.write(chat.end())
            writer?.close()
            return
          }
          const text = chat.push({ kind: "event", event: next.value })
          if (text.length > 0) {
            writer?.write(text)
            return
          }
        }
      } catch (error) {
        // Log the detail. Send the client a generic error part, then end the run.
        const requestId = logInternalError(error, `chat stream ${turn.messageId}`)
        writer?.write(encodeSseChunk({ type: "error", errorText: internalErrorText(requestId) }))
        writer?.write(chat.end())
        writer?.close()
      }
    },
    cancel() {
      writer?.stop()
    },
  })
  return new Response(stream, { headers: UI_MESSAGE_STREAM_HEADERS })
}

/**
 * The seq a subscription starts at: one past `Last-Event-ID`, or 0 (the whole
 * log) when the header is absent or not a seq.
 */
export function resumeSeq(request: Request): number {
  const header = request.headers.get("last-event-id")
  if (header === null || !/^\d+$/u.test(header.trim())) return 0
  const seq = Number(header.trim())
  return Number.isSafeInteger(seq) ? seq + 1 : 0
}

/**
 * Stream a session's event log as SSE, one entry per event with `id: seq`
 * (spec 2.4). It replays from {@link resumeSeq}, then streams live entries
 * until the client goes away.
 */
export function eventLogResponse(
  backend: SessionBackend,
  sessionId: string,
  request: Request,
  options: StreamOptions,
): Response {
  const fromSeq = resumeSeq(request)
  let writer: SseWriter | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let unsubscribe = () => {}
      writer = new SseWriter(controller, options.keepAliveMs, () => unsubscribe())
      writer.write("retry: 1000\n\n")
      // Log the detail. Send the client a generic error event, then close.
      const fail = (error: unknown): void => {
        const requestId = logInternalError(error, `event log ${sessionId}`)
        writer?.write(
          `event: error\ndata: ${JSON.stringify({ error: INTERNAL_ERROR, requestId })}\n\n`,
        )
        writer?.close()
      }
      const listener = (entry: SessionEntry): void => {
        try {
          writer?.write(serializeEntrySse(entry))
        } catch (error) {
          fail(error)
        }
      }
      try {
        unsubscribe = backend.subscribe(sessionId, listener, { fromSeq })
      } catch (error) {
        fail(error)
        return
      }
      request.signal.addEventListener("abort", () => writer?.stop(), { once: true })
    },
    cancel() {
      writer?.stop()
    },
  })
  return new Response(stream, { headers: EVENT_STREAM_HEADERS })
}
