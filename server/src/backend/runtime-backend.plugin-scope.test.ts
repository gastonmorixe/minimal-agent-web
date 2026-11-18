/**
 * Two web sessions in one server process: a plugin tool of each session sees
 * THAT session, not the boot values of the process.
 *
 * Alex (11-18), the capture `session-web-tools-wrong-info`: session-1 ran
 * anthropic / claude-haiku-5-5, session-2 ran cursor / cursor-auto. In
 * session-2, ModelInfo and SessionInfo reported the boot default model
 * (deepseek-v4.1-flash / opencode-zen), the process sid or "unknown", the
 * usage of both sessions, and one net-dbg folder held both sessions'
 * requests. This test makes the same shape with two stub providers: the boot
 * default is a third model, and no session ever switches its target.
 *
 * @module backend/runtime-backend.plugin-scope.test
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { RuntimeBackend } from "./runtime-backend.ts"
import {
  type StubProviderHome,
  stubBootOptions,
  writeStubProviderHome,
} from "./stub-provider.fixture.ts"

const savedHome = process.env.MINIMAL_AGENT_HOME
const PROBE = "ScopeProbe"

let a: StubProviderHome
let b: StubProviderHome
let host: BootedHost
let backend: RuntimeBackend
let probeLog: string

/** A plugin tool that writes what its handler context says, one JSON line per call. */
function writeProbePlugin(home: string, log: string): void {
  const dir = join(home, "plugins", "scope-probe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "scope-probe",
      name: "scope-probe",
      version: "0.1.0",
      description: "test probe",
      capabilities: ["session-info:read"],
      headless: {
        tools: [
          {
            id: "probe",
            trigger: {
              type: "tool",
              tool: {
                name: PROBE,
                description: "probe",
                input_schema: { type: "object", properties: {} },
                explicitName: true,
              },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
      },
    }),
  )
  writeFileSync(
    join(dir, "h.ts"),
    `import { appendFileSync } from "node:fs"
export default async function handler(ctx) {
  const info = ctx.queryModelInfo?.()
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({
    agent: ctx.agent ?? null,
    envSid: ctx.env.MINIMAL_AGENT_SESSION_ID ?? null,
    modelId: info?.modelId ?? null,
    providerId: info?.providerId ?? null,
    target: ctx.queryTarget?.() ?? null,
    turns: ctx.host?.sessionInfo?.tokens().turns ?? null,
  }) + "\\n")
  return { kind: "tool_result", content: "ok" }
}
`,
  )
}

beforeAll(async () => {
  a = writeStubProviderHome("scpa", { toolName: PROBE })
  b = writeStubProviderHome("scpb", { toolName: PROBE })
  cpSync(join(b.home, "plugins", "llm-scpb"), join(a.home, "plugins", "llm-scpb"), {
    recursive: true,
  })
  probeLog = join(a.root, "probe.jsonl")
  writeProbePlugin(a.home, probeLog)
  // The boot default is the model of provider A. Session 2 runs provider B.
  host = await bootHost({ ...stubBootOptions(a), version: "7.7.7" })
  backend = new RuntimeBackend({ host, retryCeilingMs: 5, version: "7.7.7" })
})

afterAll(() => {
  backend.close()
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(a.root, { recursive: true, force: true })
  rmSync(b.root, { recursive: true, force: true })
})

async function turn(id: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of (await backend.startTurn(id, { text: "go" })).events) out.push(event)
  return out
}

/** One line of the probe log. */
interface Probe {
  sessionId: unknown
  version: unknown
  envSid: unknown
  modelId: unknown
  providerId: unknown
  target: unknown
  turns: unknown
}

function probes(): Probe[] {
  if (!existsSync(probeLog)) return []
  return readFileSync(probeLog, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l): Probe => {
      const v: unknown = JSON.parse(l)
      const get = (k: string): unknown =>
        typeof v === "object" && v !== null ? Reflect.get(v, k) : undefined
      const agent = get("agent")
      const fromAgent = (k: string): unknown =>
        typeof agent === "object" && agent !== null ? Reflect.get(agent, k) : undefined
      return {
        sessionId: fromAgent("sessionId"),
        version: fromAgent("version"),
        envSid: get("envSid"),
        modelId: get("modelId"),
        providerId: get("providerId"),
        target: get("target"),
        turns: get("turns"),
      }
    })
}

describe("web sessions: each plugin call sees its own session", () => {
  test("two sessions on two providers: the probe reports each session, never the boot values", async () => {
    const s1 = await backend.createSession({ model: a.modelId, providerId: "scpa" })
    const s2 = await backend.createSession({ model: b.modelId, providerId: "scpb" })
    // Session ids are UUIDs: one id for the API, the transcript and the plugins.
    expect(s1.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(s1.id).not.toBe(s2.id)

    // The two turns run at the same time, as two browser tabs can.
    await Promise.all([turn(s1.id), turn(s2.id)])

    const seen = probes()
    expect(seen).toHaveLength(2)
    const of = (sid: string) => seen.filter((p) => p.sessionId === sid)
    const p1 = of(s1.id)
    const p2 = of(s2.id)
    expect(p1).toHaveLength(1)
    expect(p2).toHaveLength(1)
    const [p] = p1
    expect(p?.envSid).toBe(s1.id)
    expect(p?.modelId).toBe(a.modelId)
    expect(p?.providerId).toBe("scpa")
    expect(p?.target).toEqual({ providerId: "scpa", model: a.modelId })
    expect(p?.version).toBe("7.7.7")
    const [q] = p2
    expect(q?.envSid).toBe(s2.id)
    expect(q?.modelId).toBe(b.modelId)
    expect(q?.providerId).toBe("scpb")
    expect(q?.target).toEqual({ providerId: "scpb", model: b.modelId })
    // Each session counts only its own response (the first round), not the
    // response of the other session that ran at the same time.
    expect(p?.turns).toBe(1)
    expect(q?.turns).toBe(1)
  })
})
