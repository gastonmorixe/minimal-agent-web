/**
 * The app root: the token gate, the session list, and the open session.
 *
 * Without a token (see `api/token.ts`) the app shows how to get one and
 * calls nothing. The server's `transport` decides the top line. In scripted
 * mode (`MA_WEB_SCRIPTED=1`, AGENTS.md, "Session backend") a banner shows on
 * every page, so a scripted reply is never taken for a real agent's. In
 * provider mode a short line names the provider and the usable credential
 * count from `GET /api/models`. The person picks a credential and a model
 * for each new session. Nothing is auto-picked. An open session can change
 * its credential, model and effort at any time (`session/target-control.tsx`).
 *
 * @module App
 */

import { FlaskConicalIcon, KeyRoundIcon } from "lucide-react"
import * as React from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TooltipProvider } from "@/components/ui/tooltip"

import { createSession, listModels, listSessions, onUnauthorized } from "./api/client.ts"
import { getToken } from "./api/token.ts"
import type { CredentialInfo, ModelRow, SessionSummary, TransportInfo } from "./api/types.ts"
import { Button } from "./components/ui/button.tsx"
import { type Route, useRoute } from "./router.ts"
import { credentialMapFor, NewSessionPanel } from "./session/new-session-dialog.tsx"
import { SessionList } from "./session/session-list.tsx"
import { SessionPage } from "./session/session-page.tsx"

/** The app root. */
export function App() {
  const [hasToken, setHasToken] = React.useState(() => getToken() !== null)
  React.useEffect(() => onUnauthorized(() => setHasToken(false)), [])
  return <TooltipProvider>{hasToken ? <Shell /> : <Locked />}</TooltipProvider>
}

/** Shown without a token. */
export function Locked() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-6" data-testid="locked">
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>Open the link the server printed</AlertTitle>
        <AlertDescription>
          The server prints a URL with the API token after "#token=" when it starts. Open that URL.
          The token stays in this tab and is sent only in the Authorization header. If the server
          restarted, its token changed: open the new URL.
        </AlertDescription>
      </Alert>
    </main>
  )
}

/** Empty credential list. A stable default prop: no new array per render. */
const EMPTY_CREDENTIALS: readonly CredentialInfo[] = []

/**
 * The top line for `transport` from `GET /api/sessions`. Scripted mode: a
 * banner that says every reply is scripted. Provider mode: one line with the
 * usable credential count from `GET /api/models`. No provider guess: the
 * server names no provider. The person picks a credential and a model
 * for each new session. Nothing is auto-picked.
 */
export function TransportBanner({
  transport,
  credentials = EMPTY_CREDENTIALS,
}: {
  transport: TransportInfo
  credentials?: readonly CredentialInfo[]
}) {
  if (transport.kind === "provider") {
    const usable = credentials.filter((entry) => entry.usable).length
    return (
      <p className="text-xs text-muted-foreground" data-testid="provider-line">
        {usable} credential{usable === 1 ? "" : "s"} ready: pick per session
      </p>
    )
  }
  return (
    <Alert data-testid="transport-banner">
      <FlaskConicalIcon />
      <AlertTitle>Scripted transport</AlertTitle>
      <AlertDescription>{transport.description}</AlertDescription>
    </Alert>
  )
}

/**
 * The new session button for scripted mode (`MA_WEB_SCRIPTED=1`). Scripted
 * mode has no models or credentials: one click creates a session with no
 * model. The server accepts a model-less `POST /api/sessions` only when it
 * runs without a booted host.
 */
export function ScriptedNewSessionButton({
  creating,
  onCreate,
}: {
  creating: boolean
  onCreate: () => void
}) {
  return (
    <Button onClick={onCreate} disabled={creating} size="sm" data-testid="new-session">
      {creating ? "Creating..." : "New session"}
    </Button>
  )
}

function Shell() {
  const [route, navigate] = useRoute()
  const [transport, setTransport] = React.useState<TransportInfo | null>(null)
  const [models, setModels] = React.useState<ModelRow[]>([])
  const [credentials, setCredentials] = React.useState<CredentialInfo[]>([])
  const [credentialKey, setCredentialKey] = React.useState("")
  const [modelId, setModelId] = React.useState("")
  // The effort of the new session, or "" for the model default.
  const [effort, setEffort] = React.useState("")
  const [sessions, setSessions] = React.useState<SessionSummary[]>([])
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(() => {
    void listSessions()
      .then((list) => {
        setTransport(list.transport)
        setSessions(list.sessions)
        setError(null)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
  }, [])

  React.useEffect(refresh, [refresh])

  const providerMode = transport?.kind === "provider"
  React.useEffect(() => {
    if (!providerMode) return
    void listModels()
      .then((list) => {
        setModels(list.models)
        setCredentials(list.credentials)
      })
      .catch(() => {
        setModels([])
        setCredentials([])
      })
  }, [providerMode])

  const credentialByKey = React.useMemo(() => credentialMapFor(credentials), [credentials])

  function onCredentialChange(key: string) {
    setCredentialKey(key)
    setModelId("")
    setEffort("")
  }

  // The effort levels belong to one model: a new model starts on its default.
  function onModelChange(id: string) {
    setModelId(id)
    setEffort("")
  }

  async function onCreate() {
    const credential = credentialByKey.get(credentialKey)
    if (credential === undefined || modelId === "") return
    // The select holds a composite `${providerId}:${modelId}` key (model ids
    // collide across providers and can hold a colon). Strip this credential's
    // provider prefix before the API call.
    const prefix = `${credential.providerId}:`
    const model = modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId
    setCreating(true)
    try {
      const session = await createSession({
        model,
        providerId: credential.providerId,
        credentialName: credential.credentialName,
        ...(effort !== "" ? { effort } : {}),
      })
      refresh()
      navigate({ name: "session", id: session.id, view: "chat" })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreating(false)
    }
  }

  async function onCreateScripted() {
    setCreating(true)
    try {
      const session = await createSession({})
      refresh()
      navigate({ name: "session", id: session.id, view: "chat" })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreating(false)
    }
  }

  const activeId = route.name === "session" ? route.id : null
  const open = (next: Route) => navigate(next)

  return (
    <div className="flex h-dvh flex-col">
      {transport !== null && (
        <div className="border-b px-4 py-2">
          <TransportBanner transport={transport} credentials={credentials} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col gap-3 border-r p-3">
          <p className="px-1 text-sm font-medium">minimal-agent</p>
          {providerMode && (
            <NewSessionPanel
              models={models}
              credentials={credentials}
              credentialKey={credentialKey}
              modelId={modelId}
              effort={effort}
              creating={creating}
              onCredentialChange={onCredentialChange}
              onModelChange={onModelChange}
              onEffortChange={setEffort}
              onCreate={() => void onCreate()}
            />
          )}
          {transport?.kind === "scripted" && (
            <ScriptedNewSessionButton
              creating={creating}
              onCreate={() => void onCreateScripted()}
            />
          )}
          <SessionList
            sessions={sessions}
            activeId={activeId}
            onOpen={(id) => open({ name: "session", id, view: "chat" })}
          />
          {error !== null && (
            <Alert variant="destructive" data-testid="create-error">
              <AlertTitle>New session failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {route.name === "session" ? (
            <SessionPage
              key={route.id}
              id={route.id}
              view={route.view}
              summary={sessions.find((session) => session.id === route.id)}
              models={models}
              credentials={credentials}
              onView={(view) => open({ name: "session", id: route.id, view })}
              onActivity={refresh}
            />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">Open a session or start a new one.</p>
          )}
        </main>
      </div>
    </div>
  )
}
