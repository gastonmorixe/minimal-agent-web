/**
 * The text stub fixture plugin must list every required synthetic kind. When
 * core adds a required kind, this test fails until the stub manifest has it,
 * so spawn tests do not fail the boot contract check with no clear reason.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { TEXT_CONTRACTS } from "@minimal-agent/core/host-kit/plugin-loader"

import { TEXT_STUB_PLUGIN_DIR } from "./stub-provider.fixture.ts"

/** The kinds list of the first syntheticText entry, read with no type assertion. */
function syntheticKinds(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null || !("syntheticText" in manifest)) return []
  const entries = manifest.syntheticText
  if (!Array.isArray(entries)) return []
  const first: unknown = entries[0]
  if (typeof first !== "object" || first === null || !("kinds" in first)) return []
  const kinds: unknown = first.kinds
  return Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === "string") : []
}

describe("text stub fixture plugin", () => {
  it("lists exactly the required synthetic kinds of core", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(join(TEXT_STUB_PLUGIN_DIR, "manifest.json"), "utf8"),
    )
    const required = TEXT_CONTRACTS.filter((c) => c.startsWith("synthetic:"))
      .map((c) => c.slice("synthetic:".length))
      .sort()
    expect(syntheticKinds(manifest).sort()).toEqual(required)
  })
})
