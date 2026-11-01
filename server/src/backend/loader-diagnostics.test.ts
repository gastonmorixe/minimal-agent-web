/**
 * Loader diagnostics of two concurrent web sessions (core S20, WP-06b).
 *
 * Web runs many sessions on one plugin loader. A diagnostic that the loader
 * reports during the run of session A must reach the log of session A
 * only. Core routes it by the run scope that `Session.run` sets.
 *
 * The test boots a real host over the stub provider. The stub asks for the
 * `Read` tool first. A spy executor holds both runs until both are in their
 * tool call. Then each run reports a warning on the loader diagnostics
 * handle, the same handle that a plugin `ctx.log` writes to.
 *
 * The second test uses a real plugin hook on `tool.willInvoke` that throws
 * once. The loader logger reports the error. It must reach the log of the
 * session whose run called the hook, not the boot diagnostics (core WP-09d).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { SessionEntry } from "@minimal-agent/core"
import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { RuntimeBackend } from "./runtime-backend.ts"
import {
  type StubProviderHome,
  stubBootOptions,
  writeStubProviderHome,
} from "./stub-provider.fixture.ts"

const savedHome = process.env.MINIMAL_AGENT_HOME
let stub: StubProviderHome
let host: BootedHost

beforeAll(async () => {
  stub = writeStubProviderHome("ldstub")
  writeThrowingHookPlugin(join(stub.home, "plugins", "web-diag-hook"))
  host = await bootHost(stubBootOptions(stub))
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(stub.root, { recursive: true, force: true })
})

/** The flag that arms the throwing hook. The hook throws once, then disarms. */
const ARM_FLAG = "__webDiagHookArmed"

/** Write a plugin whose `tool.willInvoke` hook throws once while armed. */
function writeThrowingHookPlugin(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id: "web-diag-hook",
    name: "web-diag-hook",
    version: "0.1.0",
    description: "test plugin: a hook that throws",
    permissions: ["hooks:tool.willInvoke"],
    headless: {
      hooks: [
        {
          id: "throw-once",
          channel: "tool.willInvoke",
          handler: { type: "module", path: "./hook.ts", export: "default" },
        },
      ],
    },
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  writeFileSync(
    join(dir, "hook.ts"),
    `export default function hook() {
  if (globalThis.${ARM_FLAG} !== true) return undefined
  globalThis.${ARM_FLAG} = false
  throw new Error("web hook probe failed")
}
`,
  )
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<number> {
  let count = 0
  for await (const event of events) if (event.type !== "run_finished") count++
  return count
}

/** The probe diagnostics in the whole log of session `id`, as JSON text. */
function probeDiags(backend: RuntimeBackend, id: string, probe = "probe warning"): string[] {
  const out: string[] = []
  const unsubscribe = backend.subscribe(
    id,
    (entry: SessionEntry) => {
      const text = JSON.stringify(entry)
      if (entry.ch === "diag" && text.includes(probe)) out.push(text)
    },
    { fromSeq: 0 },
  )
  unsubscribe()
  return out
}

describe("RuntimeBackend, loader diagnostics", () => {
  test("a loader diagnostic during the run of session A lands in the log of A only", async () => {
    const tags = ["a", "b"]
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let waiting = 0
    let made = 0
    const spyHost: BootedHost = {
      ...host,
      toolExecutorFor: (modelId, options) => {
        const executor = host.toolExecutorFor(modelId, options)
        const tag = tags[made++] ?? "none"
        return {
          async execute(toolUse, signal) {
            // Hold both runs until both are in their tool call, then emit.
            waiting++
            if (waiting === 2) release()
            await gate
            host.loader.diagnostics().warn("webpin.probe", `probe warning for ${tag}`)
            return executor.execute(toolUse, signal)
          },
        }
      },
    }
    const backend = new RuntimeBackend({ host: spyHost, retryCeilingMs: 5 })
    try {
      const a = await backend.createSession({ model: stub.modelId })
      const b = await backend.createSession({ model: stub.modelId })
      const turnA = await backend.startTurn(a.id, { text: "read the note" })
      const turnB = await backend.startTurn(b.id, { text: "read the note" })
      await Promise.all([drain(turnA.events), drain(turnB.events)])

      const diagsA = probeDiags(backend, a.id)
      const diagsB = probeDiags(backend, b.id)
      expect(diagsA.length).toBe(1)
      expect(diagsA[0]).toContain("probe warning for a")
      expect(diagsA[0]).toContain(`"sessionId":"${a.id}"`)
      expect(diagsB.length).toBe(1)
      expect(diagsB[0]).toContain("probe warning for b")
      expect(diagsB[0]).toContain(`"sessionId":"${b.id}"`)
    } finally {
      backend.close()
    }
  })

  test("a plugin hook that throws during the run of session A reports to the log of A only", async () => {
    expect(host.plugins.map((p) => p.id)).toContain("web-diag-hook")
    const bootCount = host.diagnostics.length
    let aInTool: () => void = () => {}
    const aReady = new Promise<void>((resolve) => {
      aInTool = resolve
    })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let made = 0
    const spyHost: BootedHost = {
      ...host,
      toolExecutorFor: (modelId, options) => {
        const executor = host.toolExecutorFor(modelId, options)
        const isA = made++ === 0
        return {
          async execute(toolUse, signal) {
            // The executor calls the hook. A calls it first, then holds
            // until B is in its tool call too, so both runs overlap.
            if (!isA) {
              release()
              return executor.execute(toolUse, signal)
            }
            const result = await executor.execute(toolUse, signal)
            aInTool()
            await gate
            return result
          },
        }
      },
    }
    const backend = new RuntimeBackend({ host: spyHost, retryCeilingMs: 5 })
    const flags = globalThis as Record<string, unknown>
    try {
      const a = await backend.createSession({})
      const b = await backend.createSession({})
      flags[ARM_FLAG] = true
      const turnA = await backend.startTurn(a.id, { text: "read the note" })
      const doneA = drain(turnA.events)
      await aReady
      const turnB = await backend.startTurn(b.id, { text: "read the note" })
      await Promise.all([doneA, drain(turnB.events)])

      const diagsA = probeDiags(backend, a.id, "web hook probe failed")
      const diagsB = probeDiags(backend, b.id, "web hook probe failed")
      expect(diagsA.length).toBe(1)
      expect(diagsA[0]).toContain(`"sessionId":"${a.id}"`)
      expect(diagsB).toEqual([])
      const later = JSON.stringify(host.diagnostics.slice(bootCount))
      expect(later).not.toContain("web hook probe failed")
    } finally {
      flags[ARM_FLAG] = false
      backend.close()
    }
  })
})
