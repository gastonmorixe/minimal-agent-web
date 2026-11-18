/**
 * `RuntimeBackend.setTarget`: a change of the credential, provider, model
 * and effort of ONE session, on a real `bootHost` with two stub provider
 * plugins. No network call.
 *
 * The stub writes the model, the effort and the auth of each request to a
 * file (`readRecordedRequests`). So a test proves the target of a request
 * from what the provider got, not from what the backend says.
 *
 * `host.listCredentials` and `host.resolveAuth` are replaced: the first
 * gives a fixed list of stored credentials, the second gives a
 * provider-native auth whose header names the provider, the credential and
 * the model it was resolved for. Core sends a provider-native auth as it is.
 */

import { cpSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { BackendError, type BackendErrorCode } from "./backend.ts"
import { historyFromEntries } from "./history.ts"
import { RuntimeBackend } from "./runtime-backend.ts"
import {
  type RecordedRequest,
  readRecordedRequests,
  STUB_CONTEXT_WINDOW,
  STUB_LIMITED_RETRY_AFTER_MS,
  STUB_PLAIN_CONTEXT_WINDOW,
  type StubProviderHome,
  stubBootOptions,
  writeStubProviderHome,
} from "./stub-provider.fixture.ts"

const savedHome = process.env.MINIMAL_AGENT_HOME
/** Provider A: the tool model, a plain model, a limited model, a model with no effort. */
let a: StubProviderHome
/** Provider B: one tool model. Its plugin is copied into the home of A. */
let b: StubProviderHome
let host: BootedHost
/** Each `resolveAuth` call, as `provider/credential/model`. */
let asked: string[]
/** A credential name for which `resolveAuth` fails. */
const BROKEN = "broken"
let backend: RuntimeBackend

const authFor = (providerId: string, credentialName: string | undefined, modelId: string) => ({
  kind: "custom" as const,
  headers: { "x-auth-for": `${providerId}/${credentialName ?? "(default)"}/${modelId}` },
})

const credential = (providerId: string, name: string) => ({
  providerId,
  displayName: `${providerId} provider`,
  authKind: "api-key" as const,
  source: "store" as const,
  credentialName: name,
  credentialLabel: name,
})

beforeAll(async () => {
  a = writeStubProviderHome("tgta", { targetModels: true })
  b = writeStubProviderHome("tgtb")
  cpSync(join(b.home, "plugins", "llm-tgtb"), join(a.home, "plugins", "llm-tgtb"), {
    recursive: true,
  })
  const booted = await bootHost(stubBootOptions(a))
  asked = []
  host = {
    ...booted,
    listCredentials: () => [
      credential("tgta", "full"),
      credential("tgta", "second"),
      credential("tgta", BROKEN),
      credential("tgtb", "other"),
    ],
    resolveAuth: (modelId, providerId, credentialName) => {
      asked.push(`${providerId ?? ""}/${credentialName ?? "(default)"}/${modelId}`)
      if (credentialName === BROKEN) return Promise.reject(new Error("no credentials"))
      return Promise.resolve({
        type: "provider",
        auth: authFor(providerId ?? "", credentialName, modelId),
      })
    },
  }
  backend = new RuntimeBackend({ host, retryCeilingMs: 5 })
})

afterAll(() => {
  backend.close()
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(a.root, { recursive: true, force: true })
  rmSync(b.root, { recursive: true, force: true })
})

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

/** Run one turn to its end. Returns the requests that the two stubs got for it. */
async function turn(id: string, on: RuntimeBackend = backend): Promise<RecordedRequest[]> {
  const before = [readRecordedRequests(a).length, readRecordedRequests(b).length]
  await collect((await on.startTurn(id, { text: "go" })).events)
  return [...readRecordedRequests(a).slice(before[0]), ...readRecordedRequests(b).slice(before[1])]
}

async function codeOf(promise: Promise<unknown>): Promise<BackendErrorCode | "no error"> {
  try {
    await promise
    return "no error"
  } catch (error) {
    if (error instanceof BackendError) return error.code
    throw error
  }
}

/** A new session on provider A, credential `full`, the plain model. */
function plainSession(on: RuntimeBackend = backend) {
  return on.createSession({ model: a.plainModelId, providerId: "tgta", credentialName: "full" })
}

/** The four target values of a summary. */
function targetOf(summary: {
  providerId?: string
  credentialName?: string
  model: string
  effort?: string
}) {
  return {
    providerId: summary.providerId,
    credentialName: summary.credentialName,
    model: summary.model,
    effort: summary.effort,
  }
}

describe("a new session", () => {
  test("the summary has the provider, the credential, the model, and no effort for the model default", async () => {
    const session = await plainSession()
    expect(targetOf(session)).toEqual({
      providerId: "tgta",
      credentialName: "full",
      model: a.plainModelId,
      effort: undefined,
    })
    expect(Object.keys(session)).not.toContain("effort")
    expect(session.contextWindow).toBe(STUB_PLAIN_CONTEXT_WINDOW)
  })

  test("an effort of the model is set, and each request has it", async () => {
    const session = await backend.createSession({
      model: a.plainModelId,
      providerId: "tgta",
      effort: "high",
    })
    expect(session.effort).toBe("high")
    expect((await turn(session.id)).map((r) => r.effort)).toEqual(["high"])
  })

  test("an effort that the model does not have is refused, and no session opens", async () => {
    const before = (await backend.listSessions()).length
    const unknown = backend.createSession({ model: a.plainModelId, effort: "max" })
    expect(await codeOf(unknown)).toBe("bad_target")
    const none = backend.createSession({ model: a.noEffortModelId, effort: "low" })
    expect(await codeOf(none)).toBe("bad_target")
    expect((await backend.listSessions()).length).toBe(before)
  })
})

describe("setTarget", () => {
  test("a model change: the next request goes to the new model, with an auth resolved for it", async () => {
    const session = await plainSession()
    expect((await turn(session.id)).map((r) => r.modelId)).toEqual([a.plainModelId])
    asked.length = 0
    const after = await backend.setTarget(session.id, { model: a.noEffortModelId })
    expect(asked).toEqual([`tgta/full/${a.noEffortModelId}`])
    expect(targetOf(after)).toEqual({
      providerId: "tgta",
      credentialName: "full",
      model: a.noEffortModelId,
      effort: undefined,
    })
    expect(await turn(session.id)).toEqual([
      { modelId: a.noEffortModelId, auth: authFor("tgta", "full", a.noEffortModelId) },
    ])
  })

  test("the summary reads the live target: the context window follows the model", async () => {
    const session = await plainSession()
    expect(session.contextWindow).toBe(STUB_PLAIN_CONTEXT_WINDOW)
    const after = await backend.setTarget(session.id, { model: a.modelId })
    expect(after.contextWindow).toBe(STUB_CONTEXT_WINDOW)
    expect((await backend.getSession(session.id))?.model).toBe(a.modelId)
    expect((await backend.listSessions()).find((s) => s.id === session.id)?.model).toBe(a.modelId)
  })

  test("a credential change keeps the provider and the model, and the next request has the new auth", async () => {
    const session = await plainSession()
    asked.length = 0
    const after = await backend.setTarget(session.id, { credentialName: "second" })
    expect(asked).toEqual([`tgta/second/${a.plainModelId}`])
    expect(targetOf(after)).toEqual({
      providerId: "tgta",
      credentialName: "second",
      model: a.plainModelId,
      effort: undefined,
    })
    expect((await turn(session.id)).map((r) => r.auth)).toEqual([
      authFor("tgta", "second", a.plainModelId),
    ])
  })

  test("a provider change with a model: the request goes to the other provider, on its default credential", async () => {
    const session = await plainSession()
    asked.length = 0
    const after = await backend.setTarget(session.id, { providerId: "tgtb", model: b.modelId })
    expect(asked).toEqual([`tgtb/(default)/${b.modelId}`])
    // The credential "full" belongs to provider A. It does not go to provider B.
    expect(targetOf(after)).toEqual({
      providerId: "tgtb",
      credentialName: undefined,
      model: b.modelId,
      effort: undefined,
    })
    const requests = await turn(session.id)
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      expect(request.modelId).toBe(b.modelId)
      expect(request.auth).toEqual(authFor("tgtb", undefined, b.modelId))
    }
  })

  test("a provider change with a credential of that provider", async () => {
    const session = await plainSession()
    const after = await backend.setTarget(session.id, {
      providerId: "tgtb",
      credentialName: "other",
      model: b.modelId,
    })
    expect(targetOf(after)).toMatchObject({ providerId: "tgtb", credentialName: "other" })
  })

  test("an effort change, and null for the model default", async () => {
    const session = await plainSession()
    expect((await backend.setTarget(session.id, { effort: "high" })).effort).toBe("high")
    expect((await turn(session.id)).map((r) => r.effort)).toEqual(["high"])
    const back = await backend.setTarget(session.id, { effort: null })
    expect(Object.keys(back)).not.toContain("effort")
    expect((await turn(session.id)).map((r) => r.effort)).toEqual([undefined])
  })

  test("a model change to a model with no effort levels drops the effort", async () => {
    const session = await backend.createSession({ model: a.plainModelId, effort: "high" })
    const after = await backend.setTarget(session.id, { model: a.noEffortModelId })
    expect(after.effort).toBeUndefined()
  })

  test("values that the session has already change nothing and resolve no auth", async () => {
    const session = await plainSession()
    asked.length = 0
    const after = await backend.setTarget(session.id, {
      providerId: "tgta",
      credentialName: "full",
      model: a.plainModelId,
    })
    expect(asked).toEqual([])
    expect(targetOf(after)).toEqual(targetOf(session))
  })
})

describe("setTarget refuses, and then nothing changed", () => {
  const cases: [string, Parameters<RuntimeBackend["setTarget"]>[1], BackendErrorCode][] = [
    ["a credential that is not stored", { credentialName: "nope" }, "unknown_credential"],
    [
      "a credential that is stored for an other provider only",
      { credentialName: "other" },
      "unknown_credential",
    ],
    [
      "a credential of the old provider with a new provider",
      { providerId: "tgtb", credentialName: "full", model: "tgtb-model" },
      "unknown_credential",
    ],
    ["a provider change with no model", { providerId: "tgtb" }, "unknown_model"],
    ["a model that the provider does not have", { model: "tgtb-model" }, "unknown_model"],
    ["a model that no provider has", { model: "no-such-model" }, "unknown_model"],
    [
      "a provider that is not booted",
      { providerId: "no-such-provider", model: "tgtb-model" },
      "unknown_model",
    ],
    ["an effort that the model does not have", { effort: "max" }, "bad_target"],
    [
      "an effort for a model with no effort levels",
      { model: "tgta-noeffort", effort: "low" },
      "bad_target",
    ],
    ["a credential whose auth does not resolve", { credentialName: BROKEN }, "auth_unavailable"],
  ]
  for (const [name, input, code] of cases) {
    test(`${name}: ${code}`, async () => {
      const session = await plainSession()
      const logBefore = readRecordedRequests(a).length
      expect(await codeOf(backend.setTarget(session.id, input))).toBe(code)
      expect(targetOf((await backend.getSession(session.id)) ?? session)).toEqual(targetOf(session))
      // The next request still has the first target and its auth.
      expect(await turn(session.id)).toEqual([
        { modelId: a.plainModelId, auth: authFor("tgta", "full", a.plainModelId) },
      ])
      expect(readRecordedRequests(a).length).toBe(logBefore + 1)
    })
  }

  test("a check that fails before the auth step resolves no auth", async () => {
    const session = await plainSession()
    asked.length = 0
    await codeOf(backend.setTarget(session.id, { credentialName: "nope" }))
    await codeOf(backend.setTarget(session.id, { model: "no-such-model" }))
    await codeOf(backend.setTarget(session.id, { effort: "max" }))
    expect(asked).toEqual([])
  })

  test("an unknown session: not_found", async () => {
    expect(await codeOf(backend.setTarget("session-none", { effort: "low" }))).toBe("not_found")
  })

  test("scripted mode has no target to change: bad_target", async () => {
    const scripted = new RuntimeBackend({ retryCeilingMs: 5 })
    try {
      const session = await scripted.createSession({})
      expect(await codeOf(scripted.setTarget(session.id, { model: "x" }))).toBe("bad_target")
    } finally {
      scripted.close()
    }
  })
})

describe("one server process, many sessions", () => {
  const ENV_KEYS = [
    "MINIMAL_AGENT_MODEL",
    "MINIMAL_AGENT_PROVIDER",
    "MINIMAL_AGENT_CREDENTIAL_NAME",
    "MINIMAL_AGENT_EFFORT",
  ] as const
  const envNow = () => ENV_KEYS.map((key) => process.env[key])

  test("a switch in session A does not change session B: not its summary, not its next request", async () => {
    const sessionA = await plainSession()
    const sessionB = await plainSession()
    const env = envNow()

    await backend.setTarget(sessionA.id, {
      providerId: "tgtb",
      credentialName: "other",
      model: b.modelId,
    })
    await backend.setTarget(sessionA.id, { model: b.modelId })

    // B: the same summary as before the switch in A.
    const afterB = await backend.getSession(sessionB.id)
    expect(targetOf(afterB ?? sessionA)).toEqual(targetOf(sessionB))
    expect(afterB?.contextWindow).toBe(STUB_PLAIN_CONTEXT_WINDOW)
    // B: its next request has its own provider, model and auth.
    expect(await turn(sessionB.id)).toEqual([
      { modelId: a.plainModelId, auth: authFor("tgta", "full", a.plainModelId) },
    ])
    // A: its next requests have the new target.
    for (const request of await turn(sessionA.id)) {
      expect(request.modelId).toBe(b.modelId)
      expect(request.auth).toEqual(authFor("tgtb", "other", b.modelId))
    }
    // And B again, after a turn of A.
    expect((await turn(sessionB.id)).map((r) => r.modelId)).toEqual([a.plainModelId])

    // Nothing for the process changed: the env and the loader are shared by all sessions.
    expect(envNow()).toEqual(env)
    expect(Reflect.get(host.loader, "targetSource")).toBeUndefined()
  })

  test("an effort change in session A does not change the effort of session B", async () => {
    const sessionA = await plainSession()
    const sessionB = await plainSession()
    await backend.setTarget(sessionA.id, { effort: "high" })
    expect((await turn(sessionB.id)).map((r) => r.effort)).toEqual([undefined])
    expect((await turn(sessionA.id)).map((r) => r.effort)).toEqual(["high"])
  })

  test("the tools of a session follow its model, and only its model", async () => {
    const made: string[] = []
    const spyHost: BootedHost = {
      ...host,
      toolExecutorFor: (modelId, options) => {
        made.push(modelId)
        return host.toolExecutorFor(modelId, options)
      },
    }
    const spy = new RuntimeBackend({ host: spyHost, retryCeilingMs: 5 })
    try {
      const sessionA = await plainSession(spy)
      const sessionB = await plainSession(spy)
      expect(made).toEqual([a.plainModelId, a.plainModelId])
      // A moves to the model that calls the Read tool.
      await spy.setTarget(sessionA.id, { model: a.modelId })
      const events = await collect((await spy.startTurn(sessionA.id, { text: "go" })).events)
      // The tool ran on an executor that was made for the new model of A.
      expect(JSON.stringify(events)).toContain(a.fileText)
      expect(made).toEqual([a.plainModelId, a.plainModelId, a.modelId])
      // B made no new executor.
      await turn(sessionB.id, spy)
      expect(made).toEqual([a.plainModelId, a.plainModelId, a.modelId])
      // A goes back: the executor of its first model is used again, not made again.
      await spy.setTarget(sessionA.id, { model: a.plainModelId })
      await turn(sessionA.id, spy)
      expect(made).toEqual([a.plainModelId, a.plainModelId, a.modelId])
    } finally {
      spy.close()
    }
  })

  test("two changes of one session run in order: the second one wins", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowHost: BootedHost = {
      ...host,
      resolveAuth: async (modelId, providerId, credentialName) => {
        // The first change waits in its auth step.
        if (modelId === a.noEffortModelId) await gate
        return host.resolveAuth(modelId, providerId, credentialName)
      },
    }
    const slow = new RuntimeBackend({ host: slowHost, retryCeilingMs: 5 })
    try {
      const session = await plainSession(slow)
      const first = slow.setTarget(session.id, { model: a.noEffortModelId })
      const second = slow.setTarget(session.id, { model: a.modelId })
      release()
      expect((await first).model).toBe(a.noEffortModelId)
      expect((await second).model).toBe(a.modelId)
      expect((await slow.getSession(session.id))?.model).toBe(a.modelId)
    } finally {
      slow.close()
    }
  })
})

describe("a switch while a turn waits", () => {
  test("a turn that waits one hour for a retry continues at once on the new model, and is not aborted", async () => {
    const session = await backend.createSession({
      model: a.limitedModelId,
      providerId: "tgta",
      credentialName: "full",
    })
    const events: AgentEvent[] = []
    const handle = await backend.startTurn(session.id, { text: "go" })
    const done = (async () => {
      for await (const event of handle.events) events.push(event)
    })()

    // The turn waits: a status event with the wait of one hour.
    const waiting = (): AgentEvent | undefined =>
      events.find((e) => e.type === "status" && e.phase === "retrying")
    const t0 = Date.now()
    while (waiting() === undefined) {
      if (Date.now() - t0 > 10_000) throw new Error(`no wait: ${JSON.stringify(events)}`)
      await Bun.sleep(5)
    }
    expect(waiting()).toMatchObject({ nextDelayMs: STUB_LIMITED_RETRY_AFTER_MS })
    expect((await backend.getSession(session.id))?.status).toBe("running")

    // A busy session is not refused: this is the purpose of the route.
    const switchedAt = Date.now()
    const after = await backend.setTarget(session.id, { model: a.plainModelId })
    expect(after.model).toBe(a.plainModelId)
    expect(after.status).toBe("running")

    await done
    expect(Date.now() - switchedAt).toBeLessThan(10_000)
    // The SAME turn ended with the answer of the new model.
    const finished = events.filter((e) => e.type === "run_finished")
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ outcome: "completed" })
    expect(JSON.stringify(events)).toContain(a.answerText)
    // The turn has one notice with the two full targets.
    const notices = events.filter((e) => e.type === "notice")
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      notice: {
        kind: "model_adopted",
        fromTarget: { providerId: "tgta", credentialName: "full", model: a.limitedModelId },
        toTarget: { providerId: "tgta", credentialName: "full", model: a.plainModelId },
      },
    })
    expect((await backend.getSession(session.id))?.status).toBe("idle")
  }, 30_000)
})

describe("a switch with no turn in progress", () => {
  test("adds no event to the log, so the history has no run that never ends", async () => {
    const session = await plainSession()
    await turn(session.id)
    const read = () => {
      const entries: Parameters<Parameters<RuntimeBackend["subscribe"]>[1]>[0][] = []
      backend.subscribe(session.id, (entry) => entries.push(entry), { fromSeq: 0 })()
      return entries
    }
    const before = read().filter((entry) => entry.ch === "event").length
    await backend.setTarget(session.id, { model: a.noEffortModelId })
    const entries = read()
    expect(entries.filter((entry) => entry.ch === "event").length).toBe(before)
    for (const message of historyFromEntries(entries)) {
      if (message.role === "assistant") expect(message.running).toBe(false)
    }
  })
})
