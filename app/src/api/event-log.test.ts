import { afterEach, describe, expect, test } from "bun:test"

import { SseParser, subscribeEventLog } from "./event-log.ts"
import { clearToken, initToken } from "./token.ts"
import type { SessionEntry } from "./types.ts"

describe("SseParser", () => {
  test("parses id and data, skips comments and retry, across chunk splits", () => {
    const parser = new SseParser()
    const text =
      'retry: 1000\n\n: keep-alive\n\nid: 0\ndata: {"a":1}\n\nid: 1\r\ndata: x\r\ndata: y\r\n\r\n'
    const events = text.split("").flatMap((char) => parser.push(char))
    expect(events).toEqual([
      { id: "0", data: '{"a":1}' },
      { id: "1", data: "x\ny" },
    ])
  })
})

function entry(seq: number): SessionEntry {
  return {
    v: 1,
    seq,
    ts: 1000 + seq,
    sessionId: "s1",
    ch: "event",
    data: { type: "text_delta", id: "1:text", text: `t${seq}` },
  }
}

function sse(entries: SessionEntry[]): string {
  return entries.map((item) => `id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`).join("")
}

/** The URL `fetch` was called with, whichever of its three input forms it took. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  clearToken(null)
})

describe("subscribeEventLog", () => {
  test("sends the token, and resumes with Last-Event-ID after a drop without duplicates", async () => {
    initToken({
      location: { hash: "#token=tok", pathname: "/", search: "" },
      history: { state: null, replaceState: () => {} },
      storage: null,
    })
    const calls: { url: string; headers: Headers }[] = []
    const bodies = [
      sse([entry(0), entry(1), entry(2)]),
      // The server replays from Last-Event-ID + 1; an overlap must be ignored.
      sse([entry(2), entry(3), entry(4)]),
    ]
    const fake = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: requestUrl(input), headers: new Headers(init?.headers) })
      const body = bodies.shift()
      if (body === undefined) return new Promise(() => {})
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      )
    }
    globalThis.fetch = Object.assign(fake, { preconnect: realFetch.preconnect })

    const seen: number[] = []
    const stop = subscribeEventLog("s1", { onEntry: (item) => seen.push(item.seq), retryMs: 1 })
    for (let i = 0; i < 100 && seen.length < 5; i++) await Bun.sleep(5)
    stop()

    expect(seen).toEqual([0, 1, 2, 3, 4])
    expect(calls[0]?.url).toBe("/api/sessions/s1/events")
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok")
    expect(calls[0]?.headers.get("last-event-id")).toBeNull()
    expect(calls[1]?.headers.get("last-event-id")).toBe("2")
    expect(calls.every((call) => !call.url.includes("tok"))).toBe(true)
  })

  test("starts after afterSeq", async () => {
    const headers: (string | null)[] = []
    const fake = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      headers.push(new Headers(init?.headers).get("last-event-id"))
      return new Promise(() => {})
    }
    globalThis.fetch = Object.assign(fake, { preconnect: realFetch.preconnect })
    const stop = subscribeEventLog("s1", { onEntry: () => {}, afterSeq: 41 })
    await Bun.sleep(5)
    stop()
    expect(headers).toEqual(["41"])
  })
})
