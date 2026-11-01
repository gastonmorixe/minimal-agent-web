import { describe, expect, test } from "bun:test"

import { renderToString } from "react-dom/server"

import { TransportBanner } from "./App.tsx"
import type { ModelRow } from "./api/types.ts"

const MODEL: ModelRow = {
  id: "m-1",
  providerId: "acme",
  displayName: "Acme One",
  contextWindow: 1000,
}

describe("TransportBanner", () => {
  test("scripted mode shows the scripted banner", () => {
    const html = renderToString(
      <TransportBanner transport={{ kind: "scripted", description: "scripted replies" }} />,
    )
    expect(html).toContain('data-testid="transport-banner"')
    expect(html).toContain("Scripted transport")
    expect(html).toContain("scripted replies")
  })

  test("provider mode shows no banner, only the provider and the default model", () => {
    const html = renderToString(
      <TransportBanner
        transport={{ kind: "provider", providerId: "acme", description: "real" }}
        defaultModel={MODEL}
      />,
    )
    expect(html).not.toContain("transport-banner")
    expect(html).not.toContain("Scripted")
    expect(html).toContain('data-testid="provider-line"')
    expect(html).toContain("acme")
    expect(html).toContain("Acme One")
  })
})
