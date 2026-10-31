/**
 * Server integration tests: the HTTP API of spec 4.2 over the fake backend,
 * read through a real `Bun.serve` and, for the chat stream, through the AI
 * SDK's client decode path (`DefaultChatTransport`, `readUIMessageStream`).
 * The core-backed version of these tests comes with S53.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { DefaultChatTransport, readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai"

import { FakeBackend } from "../backend/fake/fake-backend.ts"
import type { HistoryMessage } from "../backend/history.ts"
import type { ChatDataTypes } from "../chat-stream/chunks.ts"
import type { SessionEntry } from "../core-mirror/session-entry.ts"
import { startServer } from "../server.ts"

type ChatMessage = UIMessage<unknown, ChatDataTypes>

const TOKEN = "api-test-token-0123456789abcdefghijklmn"
const HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }

let root: string
let backend: FakeBackend
let server: ReturnType<typeof startServer>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ma-web-api-"))
  backend = new FakeBackend({ stepDelayMs: 1 })
  server = startServer({ appDir: root, backend, token: TOKEN, keepAliveMs: 50 })
})

afterAll(() => {
  backend.close()
  void server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

function api(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(new URL(path, server.url), { ...init, headers: { ...HEADERS, ...init.headers } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A JSON object body. */
async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (!isRecord(value)) throw new Error("body is not an object")
  return value
}

function isSessionEntry(value: unknown): value is SessionEntry {
  return (
    isRecord(value) &&
    value.v === 1 &&
    typeof value.seq === "number" &&
    (value.ch === "event" || value.ch === "diag") &&
    isRecord(value.data)
  )
}

function isChunk(value: unknown): value is UIMessageChunk<unknown, ChatDataTypes> {
  return isRecord(value) && typeof value.type === "string"
}

interface Detail {
  backend: string
  session: { id: string; title: string; status: string; runs: number }
  history: HistoryMessage[]
}

function isDetail(value: unknown): value is Detail {
  return isRecord(value) && isRecord(value.session) && Array.isArray(value.history)
}

async function post(path: string, body: unknown): Promise<Response> {
  return api(path, { method: "POST", body: JSON.stringify(body) })
}

async function newSession(): Promise<string> {
  const response = await post("/api/sessions", {})
  expect(response.status).toBe(201)
  const { session } = await json(response)
  if (!isRecord(session) || typeof session.id !== "string") throw new Error("no session id")
  return session.id
}

/** Read SSE frames from a response until `stop` returns true or the body ends. */
async function readFrames(
  response: Response,
  stop: (frames: string[]) => boolean = () => false,
): Promise<{ frames: string[]; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const body = response.body
  if (body === null) throw new Error("no body")
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []
  let buffer = ""
  while (!stop(frames)) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let end = buffer.indexOf("\n\n")
    while (end !== -1) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (!frame.startsWith(":")) frames.push(frame)
      end = buffer.indexOf("\n\n")
    }
  }
  return { frames, reader }
}

function dataOf(frames: string[]): unknown[] {
  return frames
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)))
}

function entriesOf(frames: string[]): SessionEntry[] {
  return frames
    .filter((frame) => frame.startsWith("id: "))
    .map((frame) => {
      const [idLine, dataLine] = frame.split("\n")
      const entry: unknown = JSON.parse(dataLine?.slice("data: ".length) ?? "")
      if (!isSessionEntry(entry)) throw new Error(`not an entry: ${frame}`)
      expect(idLine).toBe(`id: ${entry.seq}`)
      return entry
    })
}

/** Send a message through the AI SDK client path, as `useChat` does. */
async function chat(sessionId: string, text: string) {
  const transport = new DefaultChatTransport<ChatMessage>({
    api: new URL(`/api/sessions/${sessionId}/messages`, server.url).href,
    headers: { authorization: `Bearer ${TOKEN}` },
    prepareSendMessagesRequest: () => ({ body: { text } }),
  })
  const stream = await transport.sendMessages({
    trigger: "submit-message",
    chatId: sessionId,
    messageId: undefined,
    messages: [],
    abortSignal: undefined,
  })
  const errors: string[] = []
  let message: ChatMessage | undefined
  for await (const snapshot of readUIMessageStream<ChatMessage>({
    stream,
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  })) {
    message = snapshot
  }
  return { message, errors }
}

async function detail(sessionId: string) {
  const response = await api(`/api/sessions/${sessionId}`)
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isDetail(body)) throw new Error("not a session detail")
  return body
}

async function decodeHistory(chunks: unknown[]): Promise<ChatMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk<unknown, ChatDataTypes>>({
    start(controller) {
      for (const chunk of chunks) if (isChunk(chunk)) controller.enqueue(chunk)
      controller.close()
    },
  })
  let message: ChatMessage | undefined
  for await (const snapshot of readUIMessageStream<ChatMessage>({ stream, onError: () => {} })) {
    message = snapshot
  }
  return message
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error("timed out")
}

describe("sessions", () => {
  test("creates, lists newest first, and reads a session", async () => {
    const created = await post("/api/sessions", { model: "m1", cwd: "/w", mode: "plan" })
    expect(created.status).toBe(201)
    const { session } = await json(created)
    if (!isRecord(session)) throw new Error("no session")
    expect(session).toMatchObject({
      model: "m1",
      cwd: "/w",
      mode: "plan",
      title: "New session",
      status: "idle",
      runs: 0,
    })
    const second = await newSession()
    const list = await json(await api("/api/sessions"))
    expect(list.backend).toBe("fake")
    const ids = Array.isArray(list.sessions)
      ? list.sessions.map((item: unknown) => (isRecord(item) ? item.id : undefined))
      : []
    expect(ids[0]).toBe(second)
    expect(ids).toContain(session.id)
    expect(await detail(second)).toMatchObject({ backend: "fake", history: [] })
  })

  test("answers 404 for an unknown session on every route", async () => {
    expect((await api("/api/sessions/nope")).status).toBe(404)
    expect((await api("/api/sessions/nope/events")).status).toBe(404)
    expect((await post("/api/sessions/nope/messages", { text: "hi" })).status).toBe(404)
    expect(
      (
        await post("/api/sessions/nope/answers", {
          askId: "a",
          answer: { kind: "text", text: "x" },
        })
      ).status,
    ).toBe(404)
    expect((await post("/api/sessions/nope/abort", {})).status).toBe(404)
  })

  test("answers 400 for a bad body and 405 for a wrong method", async () => {
    const id = await newSession()
    expect((await api("/api/sessions", { method: "POST", body: "{not json" })).status).toBe(400)
    expect((await post("/api/sessions", [])).status).toBe(400)
    expect((await post("/api/sessions", { model: 3 })).status).toBe(400)
    expect((await post(`/api/sessions/${id}/messages`, { text: "  " })).status).toBe(400)
    expect((await post(`/api/sessions/${id}/messages`, {})).status).toBe(400)
    expect(
      (await post(`/api/sessions/${id}/answers`, { askId: "a", answer: { kind: "x" } })).status,
    ).toBe(400)
    const wrong = await api(`/api/sessions/${id}/messages`)
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get("allow")).toBe("POST")
    expect((await api("/api/sessions", { method: "DELETE" })).status).toBe(405)
  })
})

describe("POST /api/sessions/:id/messages", () => {
  test("streams a text turn that the AI SDK client decodes", async () => {
    const id = await newSession()
    const { message, errors } = await chat(id, "hello there")
    expect(errors).toEqual([])
    expect(message?.id).toBe("msg-0")
    const text = message?.parts.find((part) => part.type === "text")
    expect(text).toMatchObject({ state: "done" })
    expect(text?.type === "text" && text.text).toContain("fake backend")
    expect(text?.type === "text" && text.text).toContain('You wrote: "hello there"')
    const usage = message?.parts.find((part) => part.type === "data-usage")
    expect(usage).toMatchObject({ data: { kind: "turn", turn: 1 } })
  })

  test("streams a tool turn with the tool's input, output, and duration", async () => {
    const id = await newSession()
    const { message, errors } = await chat(id, "read the file with a tool")
    expect(errors).toEqual([])
    const tool = message?.parts.find((part) => part.type === "dynamic-tool")
    expect(tool).toMatchObject({
      toolName: "Read",
      state: "output-available",
      input: "README.md",
      output: { isError: false, summary: "3 lines", durationMs: 42 },
    })
    expect(message?.parts.filter((part) => part.type === "step-start")).toHaveLength(2)
  })

  test("the history of a finished turn decodes to the live message", async () => {
    const id = await newSession()
    const live = await chat(id, "think about it")
    const { history, session } = await detail(id)
    expect(session).toMatchObject({ title: "think about it", status: "idle", runs: 1 })
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(history[0]).toEqual({ id: "user-0", role: "user", text: "think about it" })
    const assistant = history[1]
    if (assistant?.role !== "assistant") throw new Error("no assistant message")
    expect(assistant.running).toBe(false)
    const replayed = await decodeHistory(assistant.chunks)
    expect(replayed).toEqual(live.message)
  })

  test("refuses a second turn while one runs (409), and abort ends the first", async () => {
    const id = await newSession()
    const first = await post(`/api/sessions/${id}/messages`, { text: "a long run" })
    expect(first.status).toBe(200)
    const reading = readFrames(first)
    expect((await post(`/api/sessions/${id}/messages`, { text: "again" })).status).toBe(409)
    const abort = await post(`/api/sessions/${id}/abort`, { reason: "test" })
    expect(await abort.json()).toEqual({ aborted: true })
    const { frames } = await reading
    expect(frames.at(-1)).toBe("data: [DONE]")
    expect(dataOf(frames)).toContainEqual({ type: "error", errorText: "aborted" })
    expect(await (await post(`/api/sessions/${id}/abort`, {})).json()).toEqual({ aborted: false })
    const { history } = await detail(id)
    expect(history.at(-1)).toMatchObject({ role: "assistant", running: false })
  })

  test("a client that goes away does not stop the run", async () => {
    const id = await newSession()
    const response = await post(`/api/sessions/${id}/messages`, { text: "tool please" })
    const { reader } = await readFrames(response, (frames) => frames.length >= 3)
    await reader.cancel()
    await waitFor(async () => (await detail(id)).session.status === "idle")
    const { history } = await detail(id)
    const last = history.at(-1)
    expect(last?.role === "assistant" && last.chunks.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
    })
  })
})

describe("POST /api/sessions/:id/answers", () => {
  async function untilAsk(id: string, text: string) {
    const response = await post(`/api/sessions/${id}/messages`, { text })
    return readFrames(response, (frames) =>
      frames.some(
        (frame) => frame.includes("tool-approval-request") || frame.includes("data-ask-user"),
      ),
    )
  }

  async function rest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string[]> {
    const { frames } = await readFrames(
      new Response(
        new ReadableStream({
          pull: async (c) => {
            const { value, done } = await reader.read()
            if (done) c.close()
            else c.enqueue(value)
          },
        }),
      ),
    )
    return frames
  }

  test("approves a tool: the run waits, then runs the tool and finishes", async () => {
    const id = await newSession()
    const { frames, reader } = await untilAsk(id, "please approve the delete")
    const request = dataOf(frames).find(
      (chunk): chunk is { type: string; approvalId: string } =>
        typeof chunk === "object" && chunk !== null && "approvalId" in chunk,
    )
    expect(request).toMatchObject({ type: "tool-approval-request", toolCallId: "call_1" })
    expect((await detail(id)).session.status).toBe("waiting")
    expect(
      (
        await post(`/api/sessions/${id}/answers`, {
          askId: "ask_9",
          answer: { kind: "approval", approved: true },
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await post(`/api/sessions/${id}/answers`, {
          askId: request?.approvalId,
          answer: { kind: "text", text: "yes" },
        })
      ).status,
    ).toBe(400)
    const answered = await post(`/api/sessions/${id}/answers`, {
      askId: request?.approvalId,
      answer: { kind: "approval", approved: true },
    })
    expect(await answered.json()).toEqual({ ok: true })
    const after = dataOf(await rest(reader))
    expect(after[0]).toEqual({
      type: "tool-approval-response",
      approvalId: "ask_1",
      approved: true,
    })
    expect(after).toContainEqual(
      expect.objectContaining({
        type: "tool-output-available",
        toolCallId: "call_1",
        output: expect.objectContaining({ summary: "2 files removed" }),
      }),
    )
    expect(after.at(-1)).toEqual({ type: "finish", finishReason: "stop" })
  })

  test("denies a tool: the call ends denied", async () => {
    const id = await newSession()
    const { reader } = await untilAsk(id, "delete it, I will approve")
    await post(`/api/sessions/${id}/answers`, {
      askId: "ask_1",
      answer: { kind: "approval", approved: false, reason: "no" },
    })
    const after = dataOf(await rest(reader))
    expect(after).toContainEqual({ type: "tool-output-denied", toolCallId: "call_1" })
  })

  test("answers a free-form question", async () => {
    const id = await newSession()
    const { reader } = await untilAsk(id, "ask me a question")
    await post(`/api/sessions/${id}/answers`, {
      askId: "ask_1",
      answer: { kind: "text", text: "dev" },
    })
    const after = dataOf(await rest(reader))
    expect(after[0]).toMatchObject({
      type: "data-ask-user",
      data: { status: "answered", answer: "dev" },
    })
    const text = after
      .map((chunk) => (isRecord(chunk) && chunk.type === "text-delta" ? chunk.delta : ""))
      .join("")
    expect(text).toContain('Using the branch "dev"')
  })

  test("abort while waiting for an answer ends the run", async () => {
    const id = await newSession()
    const { reader } = await untilAsk(id, "approve this")
    await post(`/api/sessions/${id}/abort`, {})
    const after = dataOf(await rest(reader))
    expect(after).toContainEqual({ type: "error", errorText: "aborted" })
    expect((await detail(id)).session.status).toBe("idle")
  })
})

describe("GET /api/sessions/:id/events", () => {
  const finished = (entries: SessionEntry[]) =>
    entries.some((entry) => entry.ch === "event" && entry.data.type === "run_finished")

  /** Read the event stream until `stop` holds for the entries read so far. */
  async function events(
    id: string,
    stop: (entries: SessionEntry[]) => boolean,
    headers: Record<string, string> = {},
  ) {
    const response = await api(`/api/sessions/${id}/events`, { headers })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const { frames, reader } = await readFrames(response, (seen) => stop(entriesOf(seen)))
    await reader.cancel()
    return entriesOf(frames)
  }

  test("replays the whole log with id: seq, in order", async () => {
    const id = await newSession()
    await chat(id, "use a tool")
    const full = await events(id, finished)
    expect(full[0]).toMatchObject({ v: 1, seq: 0, ch: "event", data: { type: "user_message" } })
    full.forEach((entry, index) => {
      expect(entry.seq).toBe(index)
      expect(entry.sessionId).toBe(id)
    })
    expect(full.some((entry) => entry.ch === "diag")).toBe(true)
    expect(full.at(-1)?.data).toEqual({ type: "run_finished", outcome: "completed" })
  })

  test("resumes after Last-Event-ID", async () => {
    const id = await newSession()
    await chat(id, "use a tool")
    const full = await events(id, finished)
    const resumed = await events(id, finished, { "last-event-id": "9" })
    expect(resumed[0]?.seq).toBe(10)
    expect(resumed).toEqual(full.slice(10))
    const badHeader = await events(id, (entries) => entries.length > 0, { "last-event-id": "abc" })
    expect(badHeader[0]?.seq).toBe(0)
  })

  test("streams live entries of a turn that starts later", async () => {
    const id = await newSession()
    const response = await api(`/api/sessions/${id}/events`)
    const reading = readFrames(response, (frames) =>
      entriesOf(frames).some((entry) => entry.ch === "event" && entry.data.type === "run_finished"),
    )
    await chat(id, "hi")
    const { frames, reader } = await reading
    await reader.cancel()
    const live = entriesOf(frames)
    expect(live[0]).toMatchObject({ seq: 0, data: { type: "user_message", text: "hi" } })
    expect(live.map((entry) => entry.seq)).toEqual(live.map((_, index) => index))
  })

  test("keeps each session's log apart", async () => {
    const a = await newSession()
    const b = await newSession()
    await Promise.all([chat(a, "one"), chat(b, "two")])
    const [logA, logB] = await Promise.all([events(a, finished), events(b, finished)])
    expect(logA.every((entry) => entry.sessionId === a)).toBe(true)
    expect(logB.every((entry) => entry.sessionId === b)).toBe(true)
    expect(logA[0]?.seq).toBe(0)
    expect(logB[0]?.seq).toBe(0)
  })
})
