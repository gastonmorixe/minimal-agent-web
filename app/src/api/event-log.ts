/**
 * The session event log in the browser: `GET /api/sessions/:id/events`.
 *
 * `EventSource` cannot send an `Authorization` header, and the token must
 * never be in a URL, so this reads the SSE stream with `fetch`. It keeps the
 * last `seq` it saw and, when the stream drops, reconnects with
 * `Last-Event-ID: <seq>`, so the server replays only what was missed. A new
 * page (a reload) starts with no seq, and the server replays the whole log.
 *
 * @module api/event-log
 */

import { apiFetch, UnauthorizedError } from "./client.ts"
import { isSessionEntry, type SessionEntry } from "./types.ts"

/** One parsed SSE event. */
export interface SseEvent {
  id: string | null
  data: string
}

/**
 * Parse SSE text incrementally. Push chunks of text; get complete events.
 * Comment lines (`:`) and `retry:` are skipped.
 */
export class SseParser {
  private buffer = ""
  private id: string | null = null
  private data: string[] = []

  /** Feed a chunk of the stream. Returns the events it completed. */
  push(text: string): SseEvent[] {
    this.buffer += text
    const events: SseEvent[] = []
    let newline = this.buffer.search(/\r\n|\r|\n/u)
    while (newline !== -1) {
      // A "\r" at the end may be the first half of "\r\n": wait for the next chunk.
      if (this.buffer[newline] === "\r" && newline === this.buffer.length - 1) break
      const line = this.buffer.slice(0, newline)
      const width = this.buffer.startsWith("\r\n", newline) ? 2 : 1
      this.buffer = this.buffer.slice(newline + width)
      const event = this.line(line)
      if (event !== null) events.push(event)
      newline = this.buffer.search(/\r\n|\r|\n/u)
    }
    return events
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.data.length === 0) return null
      const event = { id: this.id, data: this.data.join("\n") }
      this.data = []
      return event
    }
    if (line.startsWith(":")) return null
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "")
    if (field === "data") this.data.push(value)
    else if (field === "id") this.id = value
    return null
  }
}

/** Connection state of a subscription. */
export type EventLogState = "connecting" | "live" | "reconnecting" | "closed"

/** Options for {@link subscribeEventLog}. */
export interface EventLogOptions {
  /** Called once per entry, in seq order, never twice for one seq. */
  onEntry: (entry: SessionEntry) => void
  onState?: (state: EventLogState, error?: Error) => void
  /** Resume after this seq (sent as `Last-Event-ID`). Default: replay everything. */
  afterSeq?: number
  /** Wait before a reconnect. Default 1000 ms. */
  retryMs?: number
}

/** Subscribe to a session's event log. Returns the function that stops it. */
export function subscribeEventLog(sessionId: string, options: EventLogOptions): () => void {
  const controller = new AbortController()
  let lastSeq = options.afterSeq ?? -1
  const retryMs = options.retryMs ?? 1000

  async function connect(): Promise<void> {
    const headers: Record<string, string> = {}
    if (lastSeq >= 0) headers["last-event-id"] = String(lastSeq)
    const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      headers,
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) {
      throw new Error(`event log answered ${response.status}`)
    }
    options.onState?.("live")
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    const parser = new SseParser()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      for (const event of parser.push(value)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data)
        } catch {
          continue
        }
        if (!isSessionEntry(parsed) || parsed.seq <= lastSeq) continue
        lastSeq = parsed.seq
        options.onEntry(parsed)
      }
    }
  }

  async function run(): Promise<void> {
    options.onState?.("connecting")
    while (!controller.signal.aborted) {
      try {
        await connect()
      } catch (error) {
        if (controller.signal.aborted) break
        if (error instanceof UnauthorizedError) {
          options.onState?.("closed", error)
          return
        }
        options.onState?.("reconnecting", error instanceof Error ? error : new Error(String(error)))
      }
      if (controller.signal.aborted) break
      options.onState?.("reconnecting")
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
    options.onState?.("closed")
  }

  void run()
  return () => controller.abort()
}
