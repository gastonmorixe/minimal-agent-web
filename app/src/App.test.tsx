import { describe, expect, test } from "bun:test"

import { renderToString } from "react-dom/server"

import { ScriptedNewSessionButton, TransportBanner } from "./App.tsx"
import { isCredential } from "./api/client.ts"
import type { CredentialInfo } from "./api/types.ts"
import {
  credentialItemLabel,
  credentialKeyFor,
  credentialMapFor,
  modelKeyFor,
  NewSessionPanel,
} from "./session/new-session-dialog.tsx"

const CREDENTIALS: readonly CredentialInfo[] = Object.freeze([
  {
    providerId: "acme",
    displayName: "Acme",
    authKind: "oauth",
    credentialName: "acme-main",
    credentialLabel: "Acme main",
    usable: true,
  },
  {
    providerId: "acme",
    displayName: "Acme",
    authKind: "api-key",
    credentialName: "acme-key",
    credentialLabel: "Acme key",
    usable: true,
  },
])

describe("TransportBanner", () => {
  test("scripted mode shows the scripted banner", () => {
    const html = renderToString(
      <TransportBanner transport={{ kind: "scripted", description: "scripted replies" }} />,
    )
    expect(html).toContain('data-testid="transport-banner"')
    expect(html).toContain("Scripted transport")
    expect(html).toContain("scripted replies")
  })

  test("provider mode shows the usable credential count with no provider guess, no default model", () => {
    const html = renderToString(
      <TransportBanner
        transport={{ kind: "provider", providerId: "", description: "real" }}
        credentials={CREDENTIALS}
      />,
    )
    expect(html).not.toContain("transport-banner")
    expect(html).not.toContain("Scripted")
    expect(html).toContain('data-testid="provider-line"')
    expect(html).not.toContain("Provider")
    expect(html).toContain("credential")
    expect(html).toContain("ready")
    expect(html).toContain("pick per session")
    expect(html).not.toContain("default model")
  })

  test("provider mode counts usable credentials only", () => {
    const html = renderToString(
      <TransportBanner
        transport={{ kind: "provider", providerId: "", description: "real" }}
        credentials={[...CREDENTIALS, { ...CREDENTIALS[0], credentialName: "dead", usable: false }]}
      />,
    )
    expect(html).toContain("credential")
    expect(html).not.toContain("3 credential")
  })
})

describe("credentialKey", () => {
  test("two providers with one name get distinct keys", () => {
    const first = credentialKeyFor({ providerId: "alpha", credentialName: "shared" })
    const second = credentialKeyFor({ providerId: "beta", credentialName: "shared" })
    expect(first).toBe("alpha:shared")
    expect(second).toBe("beta:shared")
    expect(first).not.toBe(second)
  })

  test("a name with a colon still resolves to the right provider via Map", () => {
    const entries: readonly CredentialInfo[] = Object.freeze([
      {
        providerId: "alpha",
        displayName: "Alpha",
        authKind: "oauth",
        credentialName: "work:east",
        credentialLabel: "Work east",
        usable: true,
      },
      {
        providerId: "beta",
        displayName: "Beta",
        authKind: "api-key",
        credentialName: "work:east",
        credentialLabel: "Work east",
        usable: true,
      },
    ])
    const byKey = credentialMapFor(entries)
    const key = credentialKeyFor({ providerId: "beta", credentialName: "work:east" })
    expect(key).toBe("beta:work:east")
    expect(byKey.get(key)?.providerId).toBe("beta")
    expect(byKey.get(key)?.credentialName).toBe("work:east")
    expect(byKey.get("alpha:work:east")?.providerId).toBe("alpha")
  })

  test("unknown keys miss the Map", () => {
    const byKey = credentialMapFor(CREDENTIALS)
    expect(byKey.get("nope:shared")).toBeUndefined()
    expect(byKey.get(":name")).toBeUndefined()
  })
})

describe("NewSessionPanel", () => {
  const models = [
    { id: "a-model", providerId: "alpha", displayName: "A model", contextWindow: 1000 },
    { id: "b-model", providerId: "beta", displayName: "B model", contextWindow: 1000 },
  ]
  const colliding: readonly CredentialInfo[] = Object.freeze([
    {
      providerId: "alpha",
      displayName: "Alpha",
      authKind: "oauth",
      credentialName: "shared",
      credentialLabel: "Shared",
      usable: true,
    },
    {
      providerId: "beta",
      displayName: "Beta",
      authKind: "api-key",
      credentialName: "shared",
      credentialLabel: "Shared",
      usable: true,
    },
  ])
  const noop = () => {}

  test("no default: empty key shows placeholders and a disabled Create", () => {
    const html = renderToString(
      <NewSessionPanel
        models={models}
        credentials={colliding}
        credentialKey=""
        modelId=""
        creating={false}
        onCredentialChange={noop}
        onModelChange={noop}
        onCreate={noop}
      />,
    )
    expect(html).toContain("Pick a credential")
    expect(html).toContain("Pick a model")
    expect(html).toContain('disabled=""')
  })

  test("Create stays disabled for an unknown key, enabled for a known key", () => {
    const bad = renderToString(
      <NewSessionPanel
        models={models}
        credentials={colliding}
        credentialKey="nope:shared"
        modelId="alpha:a-model"
        creating={false}
        onCredentialChange={noop}
        onModelChange={noop}
        onCreate={noop}
      />,
    )
    expect(bad).toContain('data-testid="new-session"')
    expect(bad).toContain('disabled=""')
    const good = renderToString(
      <NewSessionPanel
        models={models}
        credentials={colliding}
        credentialKey="beta:shared"
        modelId="beta:b-model"
        creating={false}
        onCredentialChange={noop}
        onModelChange={noop}
        onCreate={noop}
      />,
    )
    expect(good).toContain('data-testid="new-session"')
    expect(good).not.toContain('disabled=""')
  })

  test("a colon name enables Create for the right provider only", () => {
    const colonModels = [
      { id: "east-model", providerId: "beta", displayName: "East model", contextWindow: 1000 },
    ]
    const colonCreds: readonly CredentialInfo[] = Object.freeze([
      {
        providerId: "alpha",
        displayName: "Alpha",
        authKind: "oauth",
        credentialName: "work:east",
        credentialLabel: "Work east",
        usable: true,
      },
      {
        providerId: "beta",
        displayName: "Beta",
        authKind: "api-key",
        credentialName: "work:east",
        credentialLabel: "Work east",
        usable: true,
      },
    ])
    const html = renderToString(
      <NewSessionPanel
        models={colonModels}
        credentials={colonCreds}
        credentialKey="beta:work:east"
        modelId="beta:east-model"
        creating={false}
        onCredentialChange={noop}
        onModelChange={noop}
        onCreate={noop}
      />,
    )
    expect(html).toContain('data-testid="new-session"')
    expect(html).not.toContain('disabled=""')
  })

  test("model select is disabled until a credential is picked and empty of models", () => {
    const html = renderToString(
      <NewSessionPanel
        models={models}
        credentials={colliding}
        credentialKey=""
        modelId=""
        creating={false}
        onCredentialChange={noop}
        onModelChange={noop}
        onCreate={noop}
      />,
    )
    expect(html).toContain('data-testid="model-select"')
    expect(html).not.toContain("A model")
    expect(html).not.toContain("B model")
  })

  test("model keys are composite provider and id", () => {
    expect(modelKeyFor({ providerId: "beta", id: "east-model" })).toBe("beta:east-model")
  })

  test("an unusable credential is disabled and the badge counts usable only", () => {
    const mixed: readonly CredentialInfo[] = Object.freeze([
      ...colliding,
      {
        providerId: "alpha",
        displayName: "Alpha",
        authKind: "api-key" as const,
        credentialName: "dead",
        credentialLabel: "Dead",
        usable: false,
      },
    ])
    const html = renderToString(
      <NewSessionPanel
        models={models}
        credentials={mixed}
        credentialKey=""
        modelId=""
        creating={false}
        onCredentialChange={noop}
        onModelChange={noop}
        onCreate={noop}
      />,
    )
    // Radix renders select items in a closed portal: SSR HTML holds no item
    // text. Assert the label helper and the usable-only badge instead.
    expect(credentialItemLabel(mixed[2])).toContain("(unusable)")
    expect(credentialItemLabel(mixed[0])).not.toContain("(unusable)")
    expect(html).toContain("credential")
    expect(html).toContain("ready")
    expect(html).not.toContain("3 credential")
  })
})

describe("ScriptedNewSessionButton", () => {
  const noop = () => {}

  test("scripted mode shows an enabled new-session button", () => {
    const html = renderToString(<ScriptedNewSessionButton creating={false} onCreate={noop} />)
    expect(html).toContain('data-testid="new-session"')
    expect(html).toContain("New session")
    expect(html).not.toContain('disabled=""')
  })

  test("creating disables the scripted button", () => {
    const html = renderToString(<ScriptedNewSessionButton creating onCreate={noop} />)
    expect(html).toContain('data-testid="new-session"')
    expect(html).toContain('disabled=""')
  })
})

describe("isCredential", () => {
  test("accepts a well-formed credential entry", () => {
    expect(isCredential(CREDENTIALS[0])).toBe(true)
  })

  test("rejects a bad auth kind", () => {
    expect(isCredential({ ...CREDENTIALS[0], authKind: "token" })).toBe(false)
  })

  test("rejects a missing usable flag", () => {
    const { usable: _dropped, ...noUsable } = CREDENTIALS[0]
    expect(isCredential(noUsable)).toBe(false)
  })
})
