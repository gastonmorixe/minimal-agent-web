import { describe, expect, test } from "bun:test"

import {
  GenericEndpointAuthError,
  InvariantError,
  NoProviderCredentialsError,
  NoProviderSelectedError,
  UnhandledAuthTypeError,
} from "@minimal-agent/core/errors"

import { authErrorText } from "./auth-error-text.ts"

/** Old core `storedProvidersHint` text for an empty store (core bb4d1cf). */
const OLD_NO_CREDENTIALS_HINT =
  "No provider credentials found. Run `minimal-agent provider <id> login` (e.g. `minimal-agent provider example-provider login`)."

describe("authErrorText", () => {
  test("no credentials, logged-in hint: same bytes as the old core body", () => {
    const facts = [
      { providerId: "other", labels: ["work", "home"], exampleModels: ["m2", "m3"] },
      { providerId: "bare", labels: ["default"], exampleModels: [] },
    ]
    const text = authErrorText(new NoProviderCredentialsError("acme", "acme-model", facts))
    expect(text).toBe(
      'no credentials for provider "acme" (model "acme-model"). Run minimal-agent provider acme login. ' +
        'Logged in: other (work, home) \u2014 e.g. "m2", "m3"; bare (default). ' +
        'Set "model" and "provider" in ~/.minimal-agent/config.jsonc or pass --provider <id> --model <id>.',
    )
  })

  test("no credentials, empty store: same bytes as the old core body", () => {
    const text = authErrorText(new NoProviderCredentialsError("acme", "acme-model", []))
    expect(text).toBe(
      'no credentials for provider "acme" (model "acme-model"). Run minimal-agent provider acme login. ' +
        OLD_NO_CREDENTIALS_HINT,
    )
  })

  test("no credentials, missing facts: gives the empty-store hint", () => {
    const err = new NoProviderCredentialsError("acme", "acme-model", [])
    Reflect.deleteProperty(err, "credentialedProviders")
    expect(err.toJSON().fields.credentialedProviders).toBeUndefined()
    expect(authErrorText(err)).toBe(
      'no credentials for provider "acme" (model "acme-model"). Run minimal-agent provider acme login. ' +
        OLD_NO_CREDENTIALS_HINT,
    )
  })

  test("no provider selected: same bytes as the old core body, both hint branches", () => {
    expect(authErrorText(new NoProviderSelectedError("m1", []))).toBe(
      `no provider selected for model "m1". ${OLD_NO_CREDENTIALS_HINT}`,
    )
    const facts = [{ providerId: "other", labels: ["work"], exampleModels: ["m2"] }]
    expect(authErrorText(new NoProviderSelectedError("m1", facts))).toBe(
      'no provider selected for model "m1". Logged in: other (work) \u2014 e.g. "m2". ' +
        'Set "model" and "provider" in ~/.minimal-agent/config.jsonc or pass --provider <id> --model <id>.',
    )
  })

  test("renders the generic-endpoint auth kinds", () => {
    expect(authErrorText(new GenericEndpointAuthError("bearer", "api-key"))).toBe(
      "generic-endpoint auth-type bearer requires --api-key",
    )
    expect(authErrorText(new UnhandledAuthTypeError("odd"))).toBe(
      "unhandled generic-endpoint auth-type: odd",
    )
  })

  test("gives the kind for an unknown CoreError, never an empty text", () => {
    expect(authErrorText(new InvariantError("x"))).toBe("InvariantError")
  })

  test("gives the message of a plain error", () => {
    expect(authErrorText(new Error("unknown model"))).toBe("unknown model")
    expect(authErrorText("raw")).toBe("raw")
  })

  test("an empty message gives the error name, else a fixed text, never an empty text", () => {
    expect(authErrorText(new Error(""))).toBe("Error")
    const nameless = new Error("")
    nameless.name = ""
    expect(authErrorText(nameless)).toBe("auth unavailable")
    expect(authErrorText("")).toBe("auth unavailable")
  })
})
