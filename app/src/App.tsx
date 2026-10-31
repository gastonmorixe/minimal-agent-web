/**
 * The app root: the token gate, the session list, and the open session.
 *
 * Without a token (see `api/token.ts`) the app shows how to get one and
 * calls nothing. With the fake backend, a banner says so on every page, so
 * canned replies are never taken for an agent.
 *
 * @module App
 */

import { FlaskConicalIcon, KeyRoundIcon } from "lucide-react"
import * as React from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TooltipProvider } from "@/components/ui/tooltip"

import { createSession, listSessions, onUnauthorized } from "./api/client.ts"
import { getToken } from "./api/token.ts"
import type { BackendKind, SessionSummary } from "./api/types.ts"
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

/** Says that the fake backend answers. */
export function FakeBanner() {
  return (
    <Alert data-testid="fake-banner">
      <FlaskConicalIcon />
      <AlertTitle>Fake backend</AlertTitle>
      <AlertDescription>
        Replies are canned events for development and tests. No model is called and no tool runs.
      </AlertDescription>
    </Alert>
  )
}

function Shell() {
  const [route, navigate] = useRoute()
  const [backend, setBackend] = React.useState<BackendKind | null>(null)
  const [sessions, setSessions] = React.useState<SessionSummary[]>([])
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(() => {
    void listSessions()
      .then((list) => {
        setBackend(list.backend)
        setSessions(list.sessions)
        setError(null)
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
  }, [])

  React.useEffect(refresh, [refresh])

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
      {backend === "fake" && (
        <div className="border-b px-4 py-2">
          <FakeBanner />
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
