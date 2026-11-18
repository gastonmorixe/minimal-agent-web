/**
 * `publishAgentBin`: the web server points a spawned agent at the CLI, not at
 * itself. The sub-agents plugin spawns with `selfSpawn().agent()`, which reads
 * `MINIMAL_AGENT_BIN` first and otherwise uses `process.argv[1]` (here the
 * server entry: a child would boot a second web server).
 *
 * @module backend/agent-bin.test
 */

import { describe, expect, test } from "bun:test"

import { publishAgentBin } from "./agent-bin.ts"

describe("publishAgentBin", () => {
  test("writes the sibling CLI entry with the runtime, when the var is unset", () => {
    const env: NodeJS.ProcessEnv = {}
    const written = publishAgentBin({
      installDir: "/repo/minimal-agent-web",
      env,
      execPath: "/bin/bun",
      exists: (p) => p === "/repo/minimal-agent-cli/src/index.ts",
    })
    expect(written).toBe("/bin/bun /repo/minimal-agent-cli/src/index.ts")
    expect(env.MINIMAL_AGENT_BIN).toBe(written)
  })

  test("an explicit value wins", () => {
    const env: NodeJS.ProcessEnv = { MINIMAL_AGENT_BIN: "/opt/minimal-agent" }
    expect(
      publishAgentBin({ installDir: "/repo/minimal-agent-web", env, exists: () => true }),
    ).toBeUndefined()
    expect(env.MINIMAL_AGENT_BIN).toBe("/opt/minimal-agent")
  })

  test("no CLI checkout beside the server: writes nothing", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(
      publishAgentBin({ installDir: "/repo/minimal-agent-web", env, exists: () => false }),
    ).toBeUndefined()
    expect(env.MINIMAL_AGENT_BIN).toBeUndefined()
  })
})
