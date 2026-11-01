import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"

import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import type { TurnHandle } from "./backend/backend.ts"
import { RuntimeBackend } from "./backend/runtime-backend.ts"
import { startServer } from "./server.ts"

const TOKEN = "test-token-0123456789-abcdefghijklmnop"
const TRANSPORT = { kind: "scripted" as const, description: "scripted, for tests" }
/** Text that must never reach a client: it stands for a secret detail. */
const SECRET = "secret-detail-/root/private/file.ts"

let root: string
let backend: RuntimeBackend
let server: ReturnType<typeof startServer>
let stderr: ReturnType<typeof spyOn<Console, "error">>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ma-web-internal-error-"))
  const appDir = join(root, "dist")
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, "index.html"), "<!doctype html><title>app</title>")
  backend = new RuntimeBackend({
    sendFn: () =>
      // oxlint-disable-next-line require-yield -- this test never streams a model reply.
      async function* () {
        return { blocks: [], text: "", stopReason: "end_turn" }
      },
  })
  server = startServer({ appDir, backend, transport: TRANSPORT, token: TOKEN, keepAliveMs: 60_000 })
})

afterAll(() => {
  void server.stop(true)
  backend.close()
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  stderr?.mockRestore()
})

/** Capture stderr lines, and keep them out of the test output. */
function captureStderr(): string[] {
  const lines: string[] = []
  stderr = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  })
  return lines
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, server.url), {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}` },
  })
}

/** Assert a body holds no message, no stack frame, and no file path. */
function expectNoDetail(text: string): void {
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain("secret-detail")
  expect(text).not.toMatch(/\bat\s+\S+\s+\(/u)
  expect(text).not.toContain(".ts:")
  expect(text).not.toContain("/src/")
}

describe("internal errors", () => {
  test("a route that throws a plain Error answers a generic 500", async () => {
    const lines = captureStderr()
    const original = backend.listSessions.bind(backend)
    backend.listSessions = () => Promise.reject(new Error(SECRET))
    try {
      const response = await api("/api/sessions")
      expect(response.status).toBe(500)
      expect(response.headers.get("content-type")).toStartWith("application/json")
      const text = await response.text()
      expectNoDetail(text)
      const body: unknown = JSON.parse(text)
      expect(body).toEqual({ error: "internal error", requestId: expect.any(String) })
      const requestId =
        typeof body === "object" && body !== null && "requestId" in body
          ? String(body.requestId)
          : ""
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/u)
      const logged = lines.join("\n")
      expect(logged).toContain(requestId)
      expect(logged).toContain(SECRET)
      expect(logged).toContain("internal-error.test.ts")
    } finally {
      backend.listSessions = original
    }
  })

  test("a chat stream that fails mid-stream ends with a generic error part", async () => {
    const lines = captureStderr()
    const session = await backend.createSession({})
    const original = backend.startTurn.bind(backend)
    backend.startTurn = (): Promise<TurnHandle> =>
      Promise.resolve({
        messageId: "msg-1",
        // oxlint-disable-next-line require-yield -- this stream fails before its first event.
        events: (async function* (): AsyncGenerator<AgentEvent> {
          await Promise.resolve()
          throw new Error(SECRET)
        })(),
      })
    try {
      const response = await api(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: "hi" }),
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      expectNoDetail(text)
      expect(text).toContain('"type":"error"')
      expect(text).toContain("internal error")
      expect(text).toContain('"type":"finish"')
      expect(text).toEndWith("data: [DONE]\n\n")
      expect(lines.join("\n")).toContain(SECRET)
    } finally {
      backend.startTurn = original
    }
  })

  test("an event log stream that fails ends with a generic error event", async () => {
    const lines = captureStderr()
    const session = await backend.createSession({})
    const original = backend.subscribe.bind(backend)
    backend.subscribe = () => {
      throw new Error(SECRET)
    }
    try {
      const response = await api(`/api/sessions/${session.id}/events`)
      expect(response.status).toBe(200)
      const text = await response.text()
      expectNoDetail(text)
      expect(text).toContain("event: error\n")
      expect(text).toContain("internal error")
      expect(lines.join("\n")).toContain(SECRET)
    } finally {
      backend.subscribe = original
    }
  })
})
