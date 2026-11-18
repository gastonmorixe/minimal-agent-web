/**
 * The target control of an open session: its credential, model and effort.
 *
 * A session starts on the target of its create call. This control changes it
 * at any time, also while a turn runs or waits for a retry or a quota reset:
 * the turn then continues on the new target (`POST /api/sessions/:id/target`).
 *
 * The three values are a chain: the credential gives the provider, the
 * provider gives the models, the model gives the effort levels. So:
 *
 * - The model select has only the models of the provider of the credential.
 * - The effort select has only the levels of the model.
 * - A credential of an other provider keeps the model when that provider has
 *   it. If not, nothing is sent until the person picks a model
 *   ({@link credentialPick}). Nothing is picked for the person.
 *
 * The body names a stored credential only. The token is never part of it.
 *
 * @module session/target-control
 */

import * as React from "react"
import type { CredentialInfo, ModelRow, SessionSummary, SetTargetInput } from "@/api/types.ts"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { credentialKeyFor, credentialMapFor, modelKeyFor } from "./new-session-dialog.tsx"

/** The select value for "the model default" effort. Not a level name of a model. */
export const DEFAULT_EFFORT = "\u0000default"

/** The live target of a session, from its summary. */
export type SessionTarget = Pick<
  SessionSummary,
  "providerId" | "credentialName" | "model" | "effort"
>

/** What a pick in the credential select does. */
export type CredentialPick =
  | { kind: "none" }
  | { kind: "send"; input: SetTargetInput }
  /** The provider changes and does not have the model: wait for a model pick. */
  | { kind: "needs-model"; credential: CredentialInfo }

/** The models of one provider. */
export function modelsOf(models: readonly ModelRow[], providerId: string | undefined): ModelRow[] {
  return providerId === undefined ? [] : models.filter((model) => model.providerId === providerId)
}

/** The effort levels of the model of `target`, or none. */
export function effortLevelsOf(models: readonly ModelRow[], target: SessionTarget): string[] {
  return (
    modelsOf(models, target.providerId).find((model) => model.id === target.model)?.effortLevels ??
    []
  )
}

/**
 * What to do when the person picks `credential` for a session on `target`.
 * The same provider: change the credential. An other provider that has the
 * model: change both and keep the model. An other provider that does not
 * have it: ask for a model first.
 */
export function credentialPick(
  target: SessionTarget,
  credential: CredentialInfo | undefined,
  models: readonly ModelRow[],
): CredentialPick {
  if (credential === undefined || !credential.usable) return { kind: "none" }
  const { providerId, credentialName } = credential
  if (providerId === target.providerId) {
    if (credentialName === target.credentialName) return { kind: "none" }
    return { kind: "send", input: { credentialName } }
  }
  const keeps = modelsOf(models, providerId).some((model) => model.id === target.model)
  if (!keeps) return { kind: "needs-model", credential }
  return { kind: "send", input: { providerId, credentialName, model: target.model } }
}

/**
 * The change for a model pick. `pending` is the credential of an other
 * provider that waits for this model ({@link credentialPick}), if there is one.
 */
export function modelPick(
  target: SessionTarget,
  model: ModelRow | undefined,
  pending: CredentialInfo | undefined,
): SetTargetInput | null {
  if (model === undefined) return null
  if (pending !== undefined) {
    if (model.providerId !== pending.providerId) return null
    return {
      providerId: pending.providerId,
      credentialName: pending.credentialName,
      model: model.id,
    }
  }
  if (model.providerId !== target.providerId || model.id === target.model) return null
  return { model: model.id }
}

/** The change for an effort pick: a level, or {@link DEFAULT_EFFORT} for the model default. */
export function effortPick(target: SessionTarget, value: string): SetTargetInput | null {
  if (value === DEFAULT_EFFORT) return target.effort === undefined ? null : { effort: null }
  return value === target.effort ? null : { effort: value }
}

function groupByProvider(
  credentials: readonly CredentialInfo[],
): { providerId: string; displayName: string; items: CredentialInfo[] }[] {
  const groups = new Map<string, { displayName: string; items: CredentialInfo[] }>()
  for (const credential of credentials) {
    const group = groups.get(credential.providerId)
    if (group === undefined) {
      groups.set(credential.providerId, {
        displayName: credential.displayName,
        items: [credential],
      })
    } else group.items.push(credential)
  }
  return [...groups.entries()].map(([providerId, group]) => Object.assign({ providerId }, group))
}

/** Props of {@link TargetControl}. */
export interface TargetControlProps {
  target: SessionTarget
  models: readonly ModelRow[]
  credentials: readonly CredentialInfo[]
  /** Send one change. Rejects with the reason when the server refuses it. */
  onChange: (input: SetTargetInput) => Promise<void>
}

/**
 * The credential, model and effort selects of an open session. It shows
 * nothing for a session with no provider (scripted mode has no target).
 */
export function TargetControl({ target, models, credentials, onChange }: TargetControlProps) {
  const [pending, setPending] = React.useState<CredentialInfo | undefined>(undefined)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  if (target.providerId === undefined) return null

  const byKey = credentialMapFor(credentials)
  const providerId = pending?.providerId ?? target.providerId
  const visibleModels = modelsOf(models, providerId)
  const levels = pending === undefined ? effortLevelsOf(models, target) : []
  const credentialKey =
    pending !== undefined
      ? credentialKeyFor(pending)
      : target.credentialName === undefined
        ? ""
        : credentialKeyFor({ providerId: target.providerId, credentialName: target.credentialName })
  const modelKey = pending === undefined ? modelKeyFor({ providerId, id: target.model }) : ""

  async function send(input: SetTargetInput | null) {
    if (input === null) return
    setBusy(true)
    setError(null)
    try {
      await onChange(input)
      setPending(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  function onCredential(key: string) {
    const pick = credentialPick(target, byKey.get(key), models)
    if (pick.kind === "needs-model") {
      setError(null)
      setPending(pick.credential)
    } else if (pick.kind === "send") void send(pick.input)
    else setPending(undefined)
  }

  function onModel(key: string) {
    const model = visibleModels.find((entry) => modelKeyFor(entry) === key)
    void send(modelPick(target, model, pending))
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="target-control">
      <Select value={credentialKey} onValueChange={onCredential} disabled={busy}>
        <SelectTrigger size="sm" aria-label="Credential" data-testid="target-credential">
          <SelectValue placeholder="Default credential" />
        </SelectTrigger>
        <SelectContent>
          {groupByProvider(credentials).map((group) => (
            <SelectGroup key={group.providerId}>
              <SelectLabel>{group.displayName}</SelectLabel>
              {group.items.map((entry) => (
                <SelectItem
                  key={credentialKeyFor(entry)}
                  value={credentialKeyFor(entry)}
                  disabled={!entry.usable}
                >
                  {entry.credentialLabel} · {entry.displayName}
                  {entry.usable ? null : " (unusable)"}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <Select value={modelKey} onValueChange={onModel} disabled={busy}>
        <SelectTrigger size="sm" aria-label="Model" data-testid="target-model">
          <SelectValue placeholder="Pick a model" />
        </SelectTrigger>
        <SelectContent>
          {visibleModels.map((model) => (
            <SelectItem key={modelKeyFor(model)} value={modelKeyFor(model)}>
              {model.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {levels.length > 0 && (
        <Select
          value={target.effort ?? DEFAULT_EFFORT}
          onValueChange={(value) => void send(effortPick(target, value))}
          disabled={busy}
        >
          <SelectTrigger size="sm" aria-label="Effort" data-testid="target-effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_EFFORT}>Effort: model default</SelectItem>
            {levels.map((level) => (
              <SelectItem key={level} value={level}>
                Effort: {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {pending !== undefined && (
        <p className="text-xs text-muted-foreground" data-testid="target-pending">
          {pending.displayName} does not have {target.model}. Pick a model to change.
        </p>
      )}
      {error !== null && (
        <p className="text-xs text-destructive" role="alert" data-testid="target-error">
          {error}
        </p>
      )}
    </div>
  )
}
