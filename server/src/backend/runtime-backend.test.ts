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
import type { ToolExecutor } from "@minimal-agent/core/sdk/ports"

import { BackendError } from "./backend.ts"
import { RuntimeBackend } from "./runtime-backend.ts"
import {
  readRecordedAuth,
  type StubProviderHome,
  stubBootOptions,
  writeStubProviderHome,
} from "./stub-provider.fixture.ts"

const savedHome = process.env.MINIMAL_AGENT_HOME
let stub: StubProviderHome
let host: BootedHost
let backend: RuntimeBackend

beforeAll(async () => {
  stub = writeStubProviderHome("rbstub")
  host = await bootHost(stubBootOptions(stub))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof BackendError) return error.message
  if (isRecord(error) && typeof error.message === "string") return error.message
  return String(error)
}

describe("RuntimeBackend, provider mode", () => {
  test("the boot found the stub provider and its model", () => {
    expect(host.providers).toContain(stub.providerId)
    expect(host.models.map((m) => m.id)).toContain(stub.modelId)
  })

  test("reports a provider transport with a compat providerId and no default pick", () => {
    expect(backend.transport).toEqual({
      kind: "provider",
      providerId: expect.any(String),
      description: expect.stringContaining("credentials ready"),
    })
    if (backend.transport.kind !== "provider") throw new Error("not a provider transport")
    // providerId is compat only, never an empty signal. The UI must not display it as a default pick.
    expect(backend.transport.providerId.length).toBeGreaterThan(0)
    expect(backend.transport.description).toContain("pick a credential and model per session")
  })

  test("the compat providerId prefers a usable credentialed provider", () => {
    const mixed = new RuntimeBackend({
      host: {
        ...host,
        listCredentials: () => [
          {
            providerId: "broken-provider",
            displayName: "broken provider",
            authKind: "api-key" as const,
            source: "store" as const,
            credentialName: "broken",
            credentialLabel: "broken",
            credentialInfo: { usable: false as boolean },
          },
          {
            providerId: stub.providerId,
            displayName: `${stub.providerId} provider`,
            authKind: "api-key" as const,
            source: "store" as const,
            credentialName: "good",
            credentialLabel: "good",
            credentialInfo: { usable: true as boolean },
          },
        ],
      },
      retryCeilingMs: 5,
    })
    try {
      // First usable credential wins, even when it is not the first entry.
      expect(mixed.transport).toMatchObject({ kind: "provider", providerId: stub.providerId })
    } finally {
      mixed.close()
    }
  })

  test("the transport description counts only usable credentials", () => {
    const mixed = new RuntimeBackend({
      host: {
        ...host,
        listCredentials: () => [
          {
            providerId: stub.providerId,
            displayName: `${stub.providerId} provider`,
            authKind: "api-key" as const,
            source: "store" as const,
            credentialName: "good",
            credentialLabel: "good",
            credentialInfo: { usable: true as boolean },
          },
          {
            providerId: stub.providerId,
            displayName: `${stub.providerId} provider`,
            authKind: "api-key" as const,
            source: "store" as const,
            credentialName: "broken",
            credentialLabel: "broken",
            credentialInfo: { usable: false as boolean },
          },
        ],
      },
      retryCeilingMs: 5,
    })
    try {
      expect(mixed.transport).toMatchObject({
        kind: "provider",
        providerId: stub.providerId,
        description: "1 credentials ready: pick a credential and model per session.",
      })
    } finally {
      mixed.close()
    }
  })

  test("credentials default to usable when the entry has no credentialInfo", () => {
    for (const entry of backend.credentials()) expect(entry.usable).toBe(true)
  })

  test("credentials pass through usable false from credentialInfo", () => {
    const spyBackend = new RuntimeBackend({
      host: {
        ...host,
        listCredentials: () => [
          {
            providerId: stub.providerId,
            displayName: `${stub.providerId} provider`,
            authKind: "api-key" as const,
            source: "store" as const,
            credentialName: "broken",
            credentialLabel: "broken",
            credentialInfo: { usable: false as boolean },
          },
        ],
      },
      retryCeilingMs: 5,
    })
    try {
      expect(spyBackend.credentials()).toEqual([
        expect.objectContaining({ credentialName: "broken", usable: false }),
      ])
    } finally {
      spyBackend.close()
    }
  })

  test("lists the booted models and the default model id", () => {
    const { models, defaultModelId } = backend.models()
    expect(defaultModelId).toBe(stub.modelId)
    const row = models.find((m) => m.id === stub.modelId)
    expect(row?.providerId).toBe(stub.providerId)
    expect(row?.contextWindow).toBe(stub.contextWindow)
  })

  test("a session takes its model and context window from the model row", async () => {
    const session = await backend.createSession({ model: stub.modelId })
    expect(session.model).toBe(stub.modelId)
    expect(session.contextWindow).toBe(stub.contextWindow)
  })

  test("a session without a model is refused: no default pick", async () => {
    const error: unknown = await backend.createSession({}).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: "unknown_model" })
  })

  test("a turn runs through the provider plugin and the host tools", async () => {
    const session = await backend.createSession({ model: stub.modelId })
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
    const asked: Array<[string, string | undefined, string | undefined]> = []
    const spyHost: BootedHost = {
      ...host,
      resolveAuth: (modelId, providerId, credentialName) => {
        asked.push([modelId, providerId, credentialName])
        return Promise.resolve({ type: "provider", auth: sentinel })
      },
    }
    const spyBackend = new RuntimeBackend({ host: spyHost, retryCeilingMs: 5 })
    try {
      const before = readRecordedAuth(stub).length
      const session = await spyBackend.createSession({ model: stub.modelId })
      // The backend names the provider of the model row, so a model id that
      // two providers register resolves the auth of the right one.
      expect(asked).toEqual([[stub.modelId, stub.providerId, undefined]])
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

  test("each session gets its own tool executor for its model", async () => {
    const made: Array<{ modelId: string; executor: ToolExecutor }> = []
    const spyHost: BootedHost = {
      ...host,
      toolExecutorFor: (modelId, options) => {
        const executor = host.toolExecutorFor(modelId, options)
        made.push({ modelId, executor })
        return executor
      },
    }
    const spyBackend = new RuntimeBackend({ host: spyHost, retryCeilingMs: 5 })
    try {
      const first = await spyBackend.createSession({ model: stub.modelId })
      const second = await spyBackend.createSession({ model: stub.modelId })
      expect(made.map((m) => m.modelId)).toEqual([stub.modelId, stub.modelId])
      expect(made[0]?.executor).not.toBe(made[1]?.executor)
      expect(made[0]?.executor).not.toBe(host.toolExecutor)
      // The session runs its tools on its own executor.
      const events = await collect(
        (await spyBackend.startTurn(first.id, { text: "read the note" })).events,
      )
      expect(JSON.stringify(events)).toContain(stub.fileText)
      expect(second.id).not.toBe(first.id)
    } finally {
      spyBackend.close()
    }
  })

  test("without a spy, the provider gets the stub's anonymous auth", async () => {
    const before = readRecordedAuth(stub).length
    const session = await backend.createSession({ model: stub.modelId })
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

  test("a credentialName without a providerId is refused", async () => {
    const error: unknown = await backend
      .createSession({ model: stub.modelId, credentialName: "some-name" })
      .then(
        () => null,
        (reason: unknown) => reason,
      )
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: "credential_needs_provider" })
    expect(errorMessage(error)).toContain("requires providerId")
  })

  test("an unknown credentialName for the provider is refused", async () => {
    const error: unknown = await backend
      .createSession({
        model: stub.modelId,
        providerId: stub.providerId,
        credentialName: "no-such-credential",
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      )
    expect(error).toBeInstanceOf(BackendError)
    expect(error).toMatchObject({ code: "unknown_credential" })
    expect(errorMessage(error)).toContain("no-such-credential")
  })

  test("a provider displayName is not a credentialName", async () => {
    const display = `${stub.providerId} provider`
    const spyHost: BootedHost = {
      ...host,
      listCredentials: () => [
        {
          providerId: stub.providerId,
          displayName: display,
          authKind: "api-key" as const,
          source: "store" as const,
          credentialName: "stored-cred",
          credentialLabel: "stored-cred",
        },
      ],
    }
    const spyBackend = new RuntimeBackend({ host: spyHost, retryCeilingMs: 5 })
    try {
      // No entry carries the displayName as its credentialName.
      expect(spyHost.listCredentials().map((entry) => entry.credentialName)).not.toContain(display)
      const error: unknown = await spyBackend
        .createSession({
          model: stub.modelId,
          providerId: stub.providerId,
          credentialName: display,
        })
        .then(
          () => null,
          (reason: unknown) => reason,
        )
      expect(error).toBeInstanceOf(BackendError)
      expect(error).toMatchObject({ code: "unknown_credential" })
    } finally {
      spyBackend.close()
    }
  })

  test("an explicit provider and credential reach resolveAuth and the open session", async () => {
    const name = "named-cred"
    const asked: Array<[string, string | undefined, string | undefined]> = []
    const credentialEntry = {
      providerId: stub.providerId,
      displayName: `${stub.providerId} provider`,
      authKind: "api-key" as const,
      source: "store" as const,
      credentialName: name,
      credentialLabel: name,
    }
    const sentinel = { kind: "custom" as const, headers: { "x-stub-sentinel": "named-resolve" } }
    const spyHost: BootedHost = {
      ...host,
      listCredentials: () => [credentialEntry],
      resolveAuth: (modelId, providerId, credentialName) => {
        asked.push([modelId, providerId, credentialName])
        return Promise.resolve({ type: "provider", auth: sentinel })
      },
    }
    const spyBackend = new RuntimeBackend({ host: spyHost, retryCeilingMs: 5 })
    const opened: Array<unknown> = []
    const inner: unknown = spyBackend
    if (!isRecord(inner)) throw new Error("no backend runtime")
    const runtimeValue: unknown = inner["runtime"]
    if (!isRecord(runtimeValue)) throw new Error("no backend runtime")
    const originalOpen: unknown = runtimeValue["openSession"]
    if (typeof originalOpen !== "function") throw new Error("no backend runtime")
    runtimeValue["openSession"] = (options: unknown) => {
      opened.push(options)
      return Reflect.apply(originalOpen, runtimeValue, [options])
    }
    try {
      const before = readRecordedAuth(stub).length
      const session = await spyBackend.createSession({
        model: stub.modelId,
        providerId: stub.providerId,
        credentialName: name,
      })
      expect(asked).toEqual([[stub.modelId, stub.providerId, name]])
      const first = opened[0]
      if (!isRecord(first)) throw new Error("no open options")
      expect(first["providerId"]).toBe(stub.providerId)
      expect(first["credentialName"]).toBe(name)
      const turn = await spyBackend.startTurn(session.id, { text: "read the note" })
      await collect(turn.events)
      const recorded = readRecordedAuth(stub).slice(before)
      expect(recorded).toEqual([sentinel, sentinel])
    } finally {
      spyBackend.close()
    }
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
