/**
 * `RuntimeBackend` in provider mode (WEB-PLUGINS-001 T5): a real
 * `bootHost` over a stub provider plugin in a temp dir. No network call.
 *
 * The stub asks for the core `Read` tool first, then answers with text
 * (`stub-provider.fixture.ts`). So one turn proves the real path: real
 * auth from `host.resolveAuth`, the host's tool registry and executor, no
 * scripted `sendFn`, and the model row's context window.
 */

import { rmSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { BackendError } from "./backend.ts"
import { RuntimeBackend } from "./runtime-backend.ts"
import { type StubProviderHome, writeStubProviderHome } from "./stub-provider.fixture.ts"

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
