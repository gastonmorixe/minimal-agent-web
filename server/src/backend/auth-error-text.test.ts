import { describe, expect, test } from "bun:test"

import {
  GenericEndpointAuthError,
  InvariantError,
  NoProviderCredentialsError,
  NoProviderSelectedError,
  UnhandledAuthTypeError,
} from "@minimal-agent/core/errors"

import { authErrorText } from "./auth-error-text.ts"

describe("authErrorText", () => {
  test("names the provider, the model, and the login command for no credentials", () => {
    const facts = [{ providerId: "other", labels: ["secret-label"], exampleModels: ["m2"] }]
    const text = authErrorText(new NoProviderCredentialsError("acme", "acme-model", facts))
    expect(text).toBe(
      'no credentials for provider "acme" (model "acme-model"). Run minimal-agent provider acme login.',
    )
  })

  test("renders the other startup auth kinds", () => {
    expect(authErrorText(new NoProviderSelectedError("m1", []))).toBe(
      'no provider selected for model "m1"',
    )
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
})
