/**
 * The new session picker: a credential select and a model select, no defaults.
 *
 * The person picks a credential first, then a model from that credential's
 * provider. The Create button stays disabled until both are picked. Grouping
 * is by provider, and each credential line names the label, the provider,
 * and the auth kind.
 *
 * @module session/new-session-dialog
 */

import { PlusIcon } from "lucide-react"
import type { CredentialInfo, ModelRow } from "@/api/types.ts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** Props of {@link NewSessionPanel}. */
export interface NewSessionPanelProps {
  models: readonly ModelRow[]
  credentials: readonly CredentialInfo[]
  credentialKey: string
  modelId: string
  creating: boolean
  onCredentialChange: (key: string) => void
  onModelChange: (id: string) => void
  onCreate: () => void
}

/**
 * The select value for a credential. The name alone is not unique: two
 * providers can share one credential name. The key is opaque: resolve it
 * with {@link credentialMapFor}, never split it. A credential name can
 * hold a colon, so parsing on a colon misroutes.
 */
export function credentialKeyFor(
  entry: Pick<CredentialInfo, "providerId" | "credentialName">,
): string {
  return `${entry.providerId}:${entry.credentialName}`
}

/** All credentials keyed by {@link credentialKeyFor}. */
export function credentialMapFor(
  credentials: readonly CredentialInfo[],
): Map<string, CredentialInfo> {
  return new Map(credentials.map((entry) => [credentialKeyFor(entry), entry]))
}

/** The text of one credential line: label, provider, auth kind, and an unusable suffix. */
export function credentialItemLabel(entry: CredentialInfo): string {
  return `${entry.credentialLabel} · ${entry.displayName} · ${entry.authKind}${entry.usable ? "" : " (unusable)"}`
}

/**
 * The select value for a model. The model id alone is not unique: two
 * providers can register one model id. The key is opaque: the app strips the
 * picked credential's provider prefix before it calls the API, never splits
 * it blindly. A model id can hold a colon, so parsing on a colon misroutes.
 */
export function modelKeyFor(model: Pick<ModelRow, "providerId" | "id">): string {
  return `${model.providerId}:${model.id}`
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
    } else {
      group.items.push(credential)
    }
  }
  return [...groups.entries()].map(([providerId, group]) => Object.assign({ providerId }, group))
}

/** The inline new session panel above the session list. */
export function NewSessionPanel({
  models,
  credentials,
  credentialKey,
  modelId,
  creating,
  onCredentialChange,
  onModelChange,
  onCreate,
}: NewSessionPanelProps) {
  const byKey = credentialMapFor(credentials)
  const picked = credentialKey === "" ? undefined : byKey.get(credentialKey)
  const visibleModels =
    picked === undefined ? [] : models.filter((model) => model.providerId === picked.providerId)
  const ready = picked !== undefined && modelId !== ""
  const usableCount = credentials.filter((entry) => entry.usable).length

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-2" data-testid="new-session-panel">
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium">New session</span>
        <Badge
          variant={usableCount > 0 ? "secondary" : "destructive"}
          data-testid="credential-count"
        >
          {usableCount === 0
            ? "No credentials"
            : `${usableCount} credential${usableCount === 1 ? "" : "s"} ready`}
        </Badge>
      </div>
      <Select value={credentialKey} onValueChange={onCredentialChange}>
        <SelectTrigger className="w-full" data-testid="credential-select">
          <SelectValue placeholder="Pick a credential" />
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
                  {entry.credentialLabel} · {entry.displayName} · {entry.authKind}
                  {entry.usable ? null : " (unusable)"}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <Select value={modelId} onValueChange={onModelChange} disabled={picked === undefined}>
        <SelectTrigger className="w-full" data-testid="model-select">
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
      <Button onClick={onCreate} disabled={creating || !ready} size="sm" data-testid="new-session">
        <PlusIcon />
        {creating ? "Creating..." : "Create session"}
      </Button>
    </div>
  )
}
