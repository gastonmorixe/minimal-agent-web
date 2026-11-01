/**
 * The app root: the token gate, the session list, and the open session.
 *
 * Without a token (see `api/token.ts`) the app shows how to get one and
 * calls nothing. The server's `transport` decides the top line. In scripted
 * mode (`MA_WEB_SCRIPTED=1`, AGENTS.md, "Session backend") a banner shows on
 * every page, so a scripted reply is never taken for a real agent's. In
 * provider mode a short line names the provider and the default model from
 * `GET /api/models`. The app has no model picker (v1): each new session uses
 * the server's default model.
 *
 * @module App
 */

import { FlaskConicalIcon, KeyRoundIcon } from "lucide-react"
import * as React from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TooltipProvider } from "@/components/ui/tooltip"

import { createSession, listModels, listSessions, onUnauthorized } from "./api/client.ts"
import { getToken } from "./api/token.ts"
import type { ModelRow, SessionSummary, TransportInfo } from "./api/types.ts"
import { type Route, useRoute } from "./router.ts"
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

/**
 * The top line for `transport` from `GET /api/sessions`. Scripted mode: a
 * banner that says every reply is scripted. Provider mode: one line with the
 * provider and the default model, when it is known.
 */
export function TransportBanner({
  transport,
  defaultModel = null,
}: {
  transport: TransportInfo
  defaultModel?: ModelRow | null
}) {
  if (transport.kind === "provider") {
    return (
      <p className="text-xs text-muted-foreground" data-testid="provider-line">
        Provider {transport.providerId}
        {defaultModel !== null && ` · default model ${defaultModel.displayName}`}
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

function Shell() {
  const [route, navigate] = useRoute()
  const [transport, setTransport] = React.useState<TransportInfo | null>(null)
  const [defaultModel, setDefaultModel] = React.useState<ModelRow | null>(null)
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
      .then((list) =>
        setDefaultModel(list.models.find((m) => m.id === list.defaultModelId) ?? null),
      )
      .catch(() => setDefaultModel(null))
  }, [providerMode])

  async function onCreate() {
    setCreating(true)
    try {
      const session = await createSession()
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
          <TransportBanner transport={transport} defaultModel={defaultModel} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col gap-3 border-r p-3">
          <p className="px-1 text-sm font-medium">minimal-agent</p>
          <SessionList
            sessions={sessions}
            activeId={activeId}
            onOpen={(id) => open({ name: "session", id, view: "chat" })}
            onCreate={() => void onCreate()}
            creating={creating}
          />
          {error !== null && <p className="px-1 text-xs text-destructive">{error}</p>}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {route.name === "session" ? (
            <SessionPage
              key={route.id}
              id={route.id}
              view={route.view}
              summary={sessions.find((session) => session.id === route.id)}
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
