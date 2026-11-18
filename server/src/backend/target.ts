/**
 * The target change of one web session: what `POST /api/sessions/:id/target`
 * asks for, checked against the booted host, as one selection for
 * `AgentCore.switchTarget`.
 *
 * A target is the credential, the provider, the model and the effort of a
 * session. They are a chain: the credential gives the provider, the provider
 * gives the models, the model gives the effort levels. So this module checks
 * them in that order, and it refuses a value that the value on its left does
 * not have.
 *
 * Security. A session target selects the credential that the next request
 * uses, and the provider that gets it. So:
 *
 * - A credential must be a stored credential of the SAME provider
 *   (`host.listCredentials()`). The body has only its name. It never has a
 *   token, a key or an endpoint.
 * - The auth comes from `host.resolveAuth`, the same call as for a new
 *   session. A failure changes nothing.
 * - This module reads and writes no process-wide state (no `process.env`,
 *   no loader field). The change is for one `AgentCore`: one session.
 *
 * @module backend/target
 */

import type { BootedHost, ModelRow } from "@minimal-agent/core/host-kit/host-boot"
import type { AgentCore } from "@minimal-agent/core/sdk/agent-core"

import { authErrorText } from "./auth-error-text.ts"
import { BackendError, type SetTargetInput } from "./backend.ts"

/** The live target of a session's core. */
export type LiveTarget = ReturnType<AgentCore["getTarget"]>
/** What `AgentCore.switchTarget` takes. */
export type TargetSelection = Parameters<AgentCore["switchTarget"]>[0]

/** The names of the stored credentials of one provider. */
export function credentialNamesOf(host: BootedHost, providerId: string): string[] {
  const names: string[] = []
  for (const entry of host.listCredentials()) {
    if (entry.providerId === providerId && entry.credentialName !== undefined) {
      names.push(entry.credentialName)
    }
  }
  return names
}

/** Find a booted model row by id, scoped to one provider when set. */
export function findRow(
  host: BootedHost,
  modelId: string,
  providerId?: string,
): ModelRow | undefined {
  if (providerId === undefined) return host.models.find((m) => m.id === modelId)
  return host.models.find((m) => m.id === modelId && m.providerId === providerId)
}

/**
 * Refuse an effort level that the model does not have.
 *
 * @throws BackendError `bad_target`
 */
export function checkEffort(row: ModelRow, effort: string): void {
  const { levels } = row.capabilities.effort
  if (levels.includes(effort)) return
  const offered = levels.length > 0 ? levels.join(", ") : "(none: the model has no effort levels)"
  throw new BackendError(
    "bad_target",
    `model "${row.id}" does not have effort "${effort}". Levels: ${offered}`,
  )
}

/**
 * Check a target change and resolve its auth. Returns the selection for
 * `switchTarget`, or `null` when the input names only values that the
 * session has already (nothing to switch).
 *
 * `effort: null` (back to the model default) is not part of the selection:
 * the caller applies it with `setEffort(undefined)` after the switch.
 *
 * @throws BackendError `bad_target`, `unknown_credential`, `unknown_model`
 *   or `auth_unavailable`. A throw changes nothing.
 */
export async function targetSelection(
  host: BootedHost,
  current: LiveTarget,
  input: SetTargetInput,
): Promise<TargetSelection | null> {
  const providerId = input.providerId ?? current.providerId
  if (providerId === undefined) {
    throw new BackendError("bad_target", "the session has no provider: name a providerId")
  }
  const providerChanged = providerId !== current.providerId

  // 1. The credential: a stored credential of this provider, by name.
  if (input.credentialName !== undefined) {
    const known = credentialNamesOf(host, providerId)
    if (!known.includes(input.credentialName)) {
      throw new BackendError(
        "unknown_credential",
        `unknown credential "${input.credentialName}" for provider "${providerId}": no stored credential with that name`,
      )
    }
  }
  // A credential belongs to one provider: a provider change with no name uses the provider default.
  const credentialName =
    input.credentialName ?? (providerChanged ? undefined : current.credentialName)

  // 2. The model: one of the models of the provider.
  if (input.model === undefined && providerChanged) {
    throw new BackendError(
      "unknown_model",
      `a change to provider "${providerId}" needs a model of that provider`,
    )
  }
  const model = input.model ?? current.model
  const row = findRow(host, model, providerId)
  if (row === undefined) {
    throw new BackendError(
      "unknown_model",
      `provider "${providerId}" does not register model "${model}"`,
    )
  }

  // 3. The effort: one of the levels of the model.
  const effort = typeof input.effort === "string" ? input.effort : undefined
  if (effort !== undefined) checkEffort(row, effort)

  const authChanged =
    providerChanged || credentialName !== current.credentialName || model !== current.model
  if (!authChanged && (effort === undefined || effort === current.effort)) return null

  // 4. The auth of the new credential, provider and model. The same call as for a new session.
  let auth: Awaited<ReturnType<BootedHost["resolveAuth"]>> | undefined
  if (authChanged) {
    try {
      auth = await host.resolveAuth(row.id, row.providerId, credentialName)
    } catch (error) {
      throw new BackendError("auth_unavailable", authErrorText(error))
    }
  }
  return {
    providerId,
    ...(credentialName !== undefined ? { credentialName } : {}),
    model,
    ...(effort !== undefined ? { effort } : {}),
    ...(auth !== undefined ? { auth } : {}),
  }
}
