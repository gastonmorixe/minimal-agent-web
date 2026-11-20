/**
 * B1 wiring: the web session options carry the loader's synthetic and tool
 * text providers, because `runtime.openSession` has no loader of its own.
 * Step 6 (M1): they also carry the loader's sideband API.
 */

import { rmSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { createRuntime } from "@minimal-agent/core"
import { NO_SIDEBAND } from "@minimal-agent/core/host/sideband"
import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { SyntheticTextProvider } from "@minimal-agent/core/plugin-api/types/synthetic-text"
import type { ToolTextProvider } from "@minimal-agent/core/plugin-api/types/tool-text"

import { providerParts } from "./runtime-backend.ts"
import {
  type StubProviderHome,
  stubBootOptions,
  writeStubProviderHome,
} from "./stub-provider.fixture.ts"

const savedHome = process.env.MINIMAL_AGENT_HOME
let stub: StubProviderHome
let host: BootedHost

beforeAll(async () => {
  stub = writeStubProviderHome("rbtext")
  host = await bootHost(stubBootOptions(stub))
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(stub.root, { recursive: true, force: true })
})

describe("providerParts text providers (B1)", () => {
  test("passes the loader's providers to openSession", async () => {
    const synthetic: SyntheticTextProvider = {
      kinds: ["continue.max_tokens"],
      text: () => "X-web",
    }
    const tool: ToolTextProvider = { tools: ["Read"], tool: () => undefined }
    const loader: BootedHost["loader"] = Object.create(host.loader)
    loader.syntheticTextProviders = () => [synthetic]
    loader.toolTextProviders = () => [tool]
    const parts = await providerParts({ ...host, loader }, stub.modelId)
    expect(parts.open.syntheticTextProviders).toEqual([synthetic])
    expect(parts.open.syntheticTextProviders?.[0]?.text("continue.max_tokens", {})).toBe("X-web")
    expect(parts.open.toolTextProviders).toEqual([tool])
  })
})

describe("providerParts sideband (step 6, M1)", () => {
  test("passes the loader's sideband API to openSession", async () => {
    const parts = await providerParts(host, stub.modelId)
    expect(parts.open.sideband).toBe(host.loader.sideband())
  })

  test("the opened session core has the loader's sideband API", async () => {
    const parts = await providerParts(host, stub.modelId)
    const runtime = createRuntime()
    try {
      const session = runtime.openSession({ id: "sb-wire", ...parts.open })
      // The session keeps its AgentCore in a private field: read it at runtime.
      const core: unknown = Reflect.get(session, "core")
      if (typeof core !== "object" || core === null) throw new Error("session has no core")
      const sideband: unknown = Reflect.get(core, "sideband")
      expect(sideband).toBe(host.loader.sideband())
      expect(sideband).not.toBe(NO_SIDEBAND)
    } finally {
      runtime.close()
    }
  })
})
