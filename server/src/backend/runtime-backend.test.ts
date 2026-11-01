/**
 * `RuntimeBackend` in provider mode (WEB-PLUGINS-001 T5): a real
 * `bootHost` over a stub provider plugin in a temp dir. No network call.
 *
 * The stub asks for the core `Read` tool first, then answers with text
 * (`stub-provider.fixture.ts`). So one turn proves the real path: real
 * auth from `host.resolveAuth`, the host's tool registry and executor, no
 * scripted `sendFn`, and the model row's context window.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { BackendError } from "./backend.ts"
import { RuntimeBackend } from "./runtime-backend.ts"
import {
  readRecordedAuth,
  type StubProviderHome,
  writeStubProviderHome,
} from "./stub-provider.fixture.ts"

const savedHome = process.env.MINIMAL_AGENT_HOME
let stub: StubProviderHome
let host: BootedHost
let backend: RuntimeBackend

beforeAll(async () => {
  stub = writeStubProviderHome("rbstub")
  host = await bootHost({
    home: stub.home,
    embeddedDir: stub.emptyDir,
    projectDir: stub.emptyDir,
    homeDir: null,
    siblingDirs: [],
    skipPluginSync: true,
    model: stub.modelId,
  })
  backend = new RuntimeBackend({ host, retryCeilingMs: 5 })
})

afterAll(() => {
  backend.close()
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(stub.root, { recursive: true, force: true })
})

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

describe("RuntimeBackend, provider mode", () => {
  test("the boot found the stub provider and its model", () => {
    expect(host.providers).toContain(stub.providerId)
    expect(host.models.map((m) => m.id)).toContain(stub.modelId)
  })

  test("reports a provider transport, not a scripted one", () => {
    expect(backend.transport).toEqual({
      kind: "provider",
      providerId: stub.providerId,
      description: expect.stringContaining(stub.modelId),
    })
  })

  test("lists the booted models and the default model id", () => {
    const { models, defaultModelId } = backend.models()
    expect(defaultModelId).toBe(stub.modelId)
    const row = models.find((m) => m.id === stub.modelId)
    expect(row?.providerId).toBe(stub.providerId)
    expect(row?.contextWindow).toBe(stub.contextWindow)
  })

  test("a session takes its model and context window from the model row", async () => {
    const session = await backend.createSession({})
    expect(session.model).toBe(stub.modelId)
    expect(session.contextWindow).toBe(stub.contextWindow)
  })

  test("a turn runs through the provider plugin and the host tools", async () => {
    const session = await backend.createSession({})
    const turn = await backend.startTurn(session.id, { text: "read the note" })
    const events = await collect(turn.events)
    const types = events.map((e) => e.type)
    const callAt = types.indexOf("tool_call")
    const outputAt = types.indexOf("tool_output")
    expect(callAt).toBeGreaterThanOrEqual(0)
    expect(outputAt).toBeGreaterThan(callAt)
    const call = events[callAt]
    expect(call?.type === "tool_call" && call.toolName).toBe("Read")
    expect(JSON.stringify(events[outputAt])).toContain(stub.fileText)
    expect(JSON.stringify(events)).toContain(stub.answerText)
    expect(types).not.toContain("error")
    expect(types.at(-1)).toBe("run_finished")
    expect((await backend.getSession(session.id))?.status).toBe("idle")
  })

  test("each provider request gets the auth that host.resolveAuth gave", async () => {
    // Core's send re-reads the auth store for an api-key or oauth auth, so
    // that kind cannot show which auth the session got. A provider-native
    // auth goes to the provider as it is. So the spy returns one with a
    // value that nothing else makes.
    const sentinel = { kind: "custom" as const, headers: { "x-stub-sentinel": "from-resolve" } }
    const asked: string[] = []
    const spyHost: BootedHost = {
      ...host,
      resolveAuth: (modelId) => {
        asked.push(modelId)
        return Promise.resolve({ type: "provider", auth: sentinel })
      },
    }
    const spyBackend = new RuntimeBackend({ host: spyHost, retryCeilingMs: 5 })
    try {
      const before = readRecordedAuth(stub).length
      const session = await spyBackend.createSession({})
      expect(asked).toEqual([stub.modelId])
      const turn = await spyBackend.startTurn(session.id, { text: "read the note" })
      await collect(turn.events)
      const recorded = readRecordedAuth(stub).slice(before)
      // Two requests: the tool call, then the answer.
      expect(recorded).toEqual([sentinel, sentinel])
      // Never the scripted-mode placeholder.
      expect(JSON.stringify(recorded)).not.toContain("unused-scripted-transport")
    } finally {
      spyBackend.close()
    }
  })

  test("without a spy, the provider gets the stub's anonymous auth", async () => {
    const before = readRecordedAuth(stub).length
    const session = await backend.createSession({})
    await collect((await backend.startTurn(session.id, { text: "read the note" })).events)
    const recorded = readRecordedAuth(stub).slice(before)
    expect(recorded.length).toBe(2)
    for (const auth of recorded) expect(auth).toEqual(stub.anonymousAuth ?? {})
  })

  test("an unknown model is refused before a session opens", async () => {
    const error: unknown = await backend.createSession({ model: "no-such-model" }).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: "unknown_model" })
    expect((await backend.listSessions()).map((s) => s.model)).not.toContain("no-such-model")
  })
})

describe("RuntimeBackend, session cwd", () => {
  // Tools run in the server process, so the session cwd is the process cwd.
  let dir: string
  let scripted: RuntimeBackend

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-web-cwd-"))
    scripted = new RuntimeBackend({ persistDir: dir, retryCeilingMs: 5 })
  })

  afterAll(() => {
    scripted.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("the summary and the persisted meta record the process cwd", async () => {
    const session = await scripted.createSession({})
    expect(session.cwd).toBe(process.cwd())
    const firstLine = readFileSync(join(dir, `${session.id}.jsonl`), "utf8").split("\n")[0] ?? ""
    expect(JSON.parse(firstLine)).toMatchObject({ kind: "meta", cwd: process.cwd() })
  })

  test("a client cwd equal to the process cwd is accepted", async () => {
    const session = await scripted.createSession({ cwd: process.cwd() })
    expect(session.cwd).toBe(process.cwd())
  })

  test("a client cwd that differs from the process cwd is refused", async () => {
    const other = join(process.cwd(), "not-the-server-cwd")
    const error: unknown = await scripted.createSession({ cwd: other }).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: "cwd_mismatch" })
    expect((await scripted.listSessions()).map((s) => s.cwd)).not.toContain(other)
  })
})
