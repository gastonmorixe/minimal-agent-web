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
 */

import { rmSync } from "node:fs"

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
  host = await bootHost(stubBootOptions(stub))
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(stub.root, { recursive: true, force: true })
})

async function drain(events: AsyncIterable<AgentEvent>): Promise<number> {
  let count = 0
  for await (const event of events) if (event.type !== "run_finished") count++
  return count
}

/** The probe diagnostics in the whole log of session `id`, as JSON text. */
function probeDiags(backend: RuntimeBackend, id: string): string[] {
  const out: string[] = []
  const unsubscribe = backend.subscribe(
    id,
    (entry: SessionEntry) => {
      const text = JSON.stringify(entry)
      if (entry.ch === "diag" && text.includes("probe warning")) out.push(text)
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
      const a = await backend.createSession({})
      const b = await backend.createSession({})
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
})
