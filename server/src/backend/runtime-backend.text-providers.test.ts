/**
 * B1 wiring: the web session options carry the loader's synthetic and tool
 * text providers, because `runtime.openSession` has no loader of its own.
 */

import { rmSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { SyntheticTextProvider } from "@minimal-agent/core/plugin-api/types/synthetic-text"

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
    const tool = { tools: ["Read"], tool: () => undefined }
    const loader = Object.create(host.loader) as BootedHost["loader"]
    loader.syntheticTextProviders = () => [synthetic]
    loader.toolTextProviders = () => [tool] as never
    const parts = await providerParts({ ...host, loader }, stub.modelId)
    expect(parts.open.syntheticTextProviders).toEqual([synthetic])
    expect(parts.open.syntheticTextProviders?.[0]?.text("continue.max_tokens", {} as never)).toBe(
      "X-web",
    )
    expect(parts.open.toolTextProviders).toEqual([tool] as never)
  })
})
