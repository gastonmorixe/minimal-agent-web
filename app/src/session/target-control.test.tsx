import { describe, expect, test } from "bun:test"

import { renderToString } from "react-dom/server"

import { modelRowFrom, targetBody } from "../api/client.ts"
import type { CredentialInfo, ModelRow } from "../api/types.ts"

import {
  credentialPick,
  DEFAULT_EFFORT,
  effortLevelsOf,
  effortPick,
  modelPick,
  modelsOf,
  type SessionTarget,
  TargetControl,
} from "./target-control.tsx"

const cred = (providerId: string, credentialName: string, usable = true): CredentialInfo => ({
  providerId,
  displayName: providerId.toUpperCase(),
  authKind: "api-key",
  credentialName,
  credentialLabel: credentialName,
  usable,
})
const row = (providerId: string, id: string, effortLevels: string[] = []): ModelRow => ({
  id,
  providerId,
  displayName: `${id} display`,
  contextWindow: 1000,
  effortLevels,
})

const MODELS: readonly ModelRow[] = [
  row("alpha", "shared", ["low", "high"]),
  row("alpha", "alpha-only"),
  row("beta", "shared", ["low"]),
  row("beta", "beta-only"),
]
const FULL = cred("alpha", "full")
const SECOND = cred("alpha", "second")
const OTHER = cred("beta", "other")
const TARGET: SessionTarget = { providerId: "alpha", credentialName: "full", model: "shared" }
const noop = () => Promise.resolve()

describe("the chain: credential, provider, model, effort", () => {
  test("the models are the models of the provider only", () => {
    expect(modelsOf(MODELS, "alpha").map((m) => m.id)).toEqual(["shared", "alpha-only"])
    expect(modelsOf(MODELS, "beta").map((m) => m.id)).toEqual(["shared", "beta-only"])
    expect(modelsOf(MODELS, undefined)).toEqual([])
    expect(modelsOf(MODELS, "none")).toEqual([])
  })

  test("the effort levels are the levels of the model of that provider", () => {
    expect(effortLevelsOf(MODELS, TARGET)).toEqual(["low", "high"])
    expect(effortLevelsOf(MODELS, { ...TARGET, providerId: "beta" })).toEqual(["low"])
    expect(effortLevelsOf(MODELS, { ...TARGET, model: "alpha-only" })).toEqual([])
    expect(effortLevelsOf(MODELS, { ...TARGET, model: "unknown" })).toEqual([])
  })
})

describe("credentialPick", () => {
  test("a credential of the same provider: only the credential name is sent", () => {
    expect(credentialPick(TARGET, SECOND, MODELS)).toEqual({
      kind: "send",
      input: { credentialName: "second" },
    })
  })

  test("the credential that the session has already: nothing", () => {
    expect(credentialPick(TARGET, FULL, MODELS)).toEqual({ kind: "none" })
  })

  test("an other provider that has the model: provider, credential and the same model", () => {
    expect(credentialPick(TARGET, OTHER, MODELS)).toEqual({
      kind: "send",
      input: { providerId: "beta", credentialName: "other", model: "shared" },
    })
  })

  test("an other provider that does not have the model: nothing is sent, a model is asked for", () => {
    const target = { ...TARGET, model: "alpha-only" }
    expect(credentialPick(target, OTHER, MODELS)).toEqual({
      kind: "needs-model",
      credential: OTHER,
    })
  })

  test("an unknown or unusable credential: nothing", () => {
    expect(credentialPick(TARGET, undefined, MODELS)).toEqual({ kind: "none" })
    expect(credentialPick(TARGET, cred("alpha", "bad", false), MODELS)).toEqual({ kind: "none" })
  })
})

describe("modelPick", () => {
  test("a model of the provider of the session: only the model is sent", () => {
    expect(modelPick(TARGET, MODELS[1], undefined)).toEqual({ model: "alpha-only" })
  })

  test("the model that the session has already, or no model: nothing", () => {
    expect(modelPick(TARGET, MODELS[0], undefined)).toBeNull()
    expect(modelPick(TARGET, undefined, undefined)).toBeNull()
  })

  test("a model of an other provider with no pending credential: nothing", () => {
    expect(modelPick(TARGET, MODELS[3], undefined)).toBeNull()
  })

  test("with a pending credential: its provider, its name and the picked model, as one change", () => {
    expect(modelPick({ ...TARGET, model: "alpha-only" }, MODELS[3], OTHER)).toEqual({
      providerId: "beta",
      credentialName: "other",
      model: "beta-only",
    })
    // A model that is not of the provider of the pending credential is refused.
    expect(modelPick(TARGET, MODELS[1], OTHER)).toBeNull()
  })
})

describe("effortPick", () => {
  test("a level, the model default as null, and nothing for the value that is live", () => {
    expect(effortPick(TARGET, "high")).toEqual({ effort: "high" })
    expect(effortPick({ ...TARGET, effort: "high" }, "high")).toBeNull()
    expect(effortPick({ ...TARGET, effort: "high" }, DEFAULT_EFFORT)).toEqual({ effort: null })
    expect(effortPick(TARGET, DEFAULT_EFFORT)).toBeNull()
  })
})

describe("TargetControl", () => {
  const credentials = [FULL, SECOND, OTHER]

  test("shows the three selects for a session with a provider", () => {
    const html = renderToString(
      <TargetControl target={TARGET} models={MODELS} credentials={credentials} onChange={noop} />,
    )
    expect(html).toContain('data-testid="target-control"')
    expect(html).toContain('data-testid="target-credential"')
    expect(html).toContain('data-testid="target-model"')
    expect(html).toContain('data-testid="target-effort"')
    expect(html).not.toContain('data-testid="target-error"')
    expect(html).not.toContain('disabled=""')
  })

  test("shows no effort select for a model with no effort levels", () => {
    const html = renderToString(
      <TargetControl
        target={{ ...TARGET, model: "alpha-only" }}
        models={MODELS}
        credentials={credentials}
        onChange={noop}
      />,
    )
    expect(html).toContain('data-testid="target-model"')
    expect(html).not.toContain('data-testid="target-effort"')
  })

  test("shows nothing for a session with no provider (scripted mode has no target)", () => {
    const html = renderToString(
      <TargetControl
        target={{ model: "scripted-test-model" }}
        models={[]}
        credentials={[]}
        onChange={noop}
      />,
    )
    expect(html).toBe("")
  })
})

describe("the API client", () => {
  test("the body of a target change has only the four target keys that are set", () => {
    expect(targetBody({ model: "m" })).toEqual({ model: "m" })
    expect(targetBody({ effort: null })).toEqual({ effort: null })
    expect(targetBody({ providerId: "p", credentialName: "c", model: "m", effort: "low" })).toEqual(
      {
        providerId: "p",
        credentialName: "c",
        model: "m",
        effort: "low",
      },
    )
    const extra = { model: "m", token: "secret", apiKey: "sk-x" }
    expect(Object.keys(targetBody(extra))).toEqual(["model"])
    expect(targetBody({})).toEqual({})
  })

  test("a model row reads its effort levels, and a row with none is kept", () => {
    const base = { id: "m", providerId: "p", displayName: "M", contextWindow: 10 }
    expect(
      modelRowFrom({ ...base, capabilities: { effort: { levels: ["low", "high"] } } }),
    ).toEqual({ ...base, effortLevels: ["low", "high"] })
    // An older server, or a model with no levels.
    expect(modelRowFrom(base)).toEqual({ ...base, effortLevels: [] })
    expect(modelRowFrom({ ...base, capabilities: { effort: { levels: "low" } } })).toEqual({
      ...base,
      effortLevels: [],
    })
    expect(modelRowFrom({ ...base, capabilities: { effort: { levels: ["low", 7] } } })).toEqual({
      ...base,
      effortLevels: ["low"],
    })
    expect(modelRowFrom({ ...base, contextWindow: "big" })).toBeNull()
    expect(modelRowFrom(null)).toBeNull()
  })
})
