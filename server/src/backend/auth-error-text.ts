/**
 * Web text for the typed auth errors of `host.resolveAuth`.
 *
 * Core throws facts and holds no text (`CoreError.message` is empty). The web
 * server owns the wording of the 503 body. The text names the provider and
 * the model, and ends with the stored-providers hint that core sent before
 * it moved text to the hosts. It holds no secret: the error fields hold ids,
 * credential labels, and example model ids only.
 *
 * @module backend/auth-error-text
 */

import { CoreError, type StoredProviderFact } from "@minimal-agent/core/errors"

/** Text when a non-CoreError has no message and no name. */
const AUTH_UNAVAILABLE = "auth unavailable"

/** Hint for a store with no credentials. */
const NO_CREDENTIALS_HINT =
  "No provider credentials found. Run `minimal-agent provider <id> login` " +
  "(e.g. `minimal-agent provider example-provider login`)."

/**
 * Hint that lists the credentialed providers and example model ids. Same
 * bytes as the old core `storedProvidersHint` and the cli
 * `storedProvidersHintText`.
 */
export function storedProvidersHintText(providers: readonly StoredProviderFact[]): string {
  if (providers.length === 0) return NO_CREDENTIALS_HINT
  const lines = providers.map((p) => {
    const exampleText =
      p.exampleModels.length > 0
        ? ` \u2014 e.g. ${p.exampleModels.map((id) => `"${id}"`).join(", ")}`
        : ""
    return `${p.providerId} (${p.labels.join(", ")})${exampleText}`
  })
  return (
    `Logged in: ${lines.join("; ")}. ` +
    `Set "model" and "provider" in ~/.minimal-agent/config.jsonc or pass --provider <id> --model <id>.`
  )
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value)
}

function isFact(value: unknown): value is StoredProviderFact {
  return (
    typeof value === "object" &&
    value !== null &&
    "providerId" in value &&
    typeof value.providerId === "string" &&
    "labels" in value &&
    Array.isArray(value.labels) &&
    "exampleModels" in value &&
    Array.isArray(value.exampleModels)
  )
}

/** The provider facts of an error field. A missing or bad field gives none. */
function facts(value: unknown): StoredProviderFact[] {
  return Array.isArray(value) ? value.filter(isFact) : []
}

/**
 * Text of an error from `host.resolveAuth`. A known auth `CoreError` kind
 * gets web text. Any other error gives its message, else its name, else a
 * fixed text. The result is never empty.
 */
export function authErrorText(error: unknown): string {
  if (error instanceof CoreError) {
    const f = error.toJSON().fields
    switch (error.kind) {
      case "NoProviderCredentialsError":
        return (
          `no credentials for provider "${str(f.providerId)}" (model "${str(f.modelId)}"). ` +
          `Run minimal-agent provider ${str(f.providerId)} login. ` +
          storedProvidersHintText(facts(f.credentialedProviders))
        )
      case "NoProviderSelectedError":
        return (
          `no provider selected for model "${str(f.modelId)}". ` +
          storedProvidersHintText(facts(f.credentialedProviders))
        )
      case "GenericEndpointAuthError":
        return `generic-endpoint auth-type ${str(f.authType)} requires --${str(f.missing)}`
      case "UnhandledAuthTypeError":
        return `unhandled generic-endpoint auth-type: ${str(f.authType)}`
      default:
        return error.kind
    }
  }
  if (error instanceof Error) return error.message || error.name || AUTH_UNAVAILABLE
  return String(error) || AUTH_UNAVAILABLE
}
