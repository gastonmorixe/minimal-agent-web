/**
 * Web text for the typed auth errors of `host.resolveAuth`.
 *
 * Core throws facts and holds no text (`CoreError.message` is empty). The web
 * server owns the wording of the 503 body. The text names the provider and
 * the model. It holds no secret: the error fields hold ids, labels, and
 * example model ids only.
 *
 * @module backend/auth-error-text
 */

import { CoreError } from "@minimal-agent/core/errors"

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value)
}

/**
 * Text of an error from `host.resolveAuth`. A known auth `CoreError` kind
 * gets web text. Any other error gives its own message.
 */
export function authErrorText(error: unknown): string {
  if (error instanceof CoreError) {
    const f = error.toJSON().fields
    switch (error.kind) {
      case "NoProviderCredentialsError":
        return (
          `no credentials for provider "${str(f.providerId)}" (model "${str(f.modelId)}"). ` +
          `Run minimal-agent provider ${str(f.providerId)} login.`
        )
      case "NoProviderSelectedError":
        return `no provider selected for model "${str(f.modelId)}"`
      case "GenericEndpointAuthError":
        return `generic-endpoint auth-type ${str(f.authType)} requires --${str(f.missing)}`
      case "UnhandledAuthTypeError":
        return `unhandled generic-endpoint auth-type: ${str(f.authType)}`
      default:
        return error.kind
    }
  }
  return error instanceof Error ? error.message : String(error)
}
