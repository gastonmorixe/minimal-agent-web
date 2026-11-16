import { describe, expect, test } from "bun:test"

import { ContractCheckFailedError } from "@minimal-agent/core/errors"
import { TEXT_CONTRACTS } from "@minimal-agent/core/host-kit/host-boot"

import { bootErrorText, WEB_BOOT_CONTRACTS } from "./boot-error-text.ts"

describe("web boot error text", () => {
  test("the web boot requires every text contract", () => {
    expect(WEB_BOOT_CONTRACTS.requiredContracts).toBe(TEXT_CONTRACTS)
  })
  test("names the missing and duplicated contracts", () => {
    const text = bootErrorText(new ContractCheckFailedError(["text.tools"], ["prompts.template"]))
    expect(text).toContain("missing: text.tools")
    expect(text).toContain("duplicated in one plugin tier: prompts.template")
  })
  test("a plain error keeps its message", () => {
    expect(bootErrorText(new Error("boom"))).toBe("boom")
  })
})
