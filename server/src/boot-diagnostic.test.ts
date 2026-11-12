import { describe, expect, test } from "bun:test"

import { formatBootDiagnostic } from "./boot-diagnostic.ts"

describe("formatBootDiagnostic", () => {
  test("keeps the old text when the message is not empty", () => {
    expect(formatBootDiagnostic({ kind: "plugin-warning", message: "hello", code: "x.y" })).toBe(
      "minimal-agent web: boot plugin-warning: hello",
    )
  })
  test("prints code and compact data when the message is empty", () => {
    expect(
      formatBootDiagnostic({
        kind: "plugin-warning",
        message: "",
        code: "boot.contract_missing",
        data: { contract: "c.one" },
      }),
    ).toBe('minimal-agent web: boot plugin-warning: boot.contract_missing {"contract":"c.one"}')
  })
  test("prints only the code when data is absent", () => {
    expect(formatBootDiagnostic({ kind: "k", message: "", code: "a.b" })).toBe(
      "minimal-agent web: boot k: a.b",
    )
  })
  test("prints an empty message when there is no code", () => {
    expect(formatBootDiagnostic({ kind: "k", message: "" })).toBe("minimal-agent web: boot k: ")
  })
})
