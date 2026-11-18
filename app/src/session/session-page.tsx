/**
 * One open session: its header, the chat, and the trace view.
 *
 * The page holds one event log subscription for the session. The trace view
 * draws from it, and the chat uses it to see runs it did not start. The chat
 * stays mounted while the trace is shown, so a turn keeps streaming.
 *
 * The header has the target control (`target-control.tsx`): the credential,
 * the model and the effort of the session. It stays active during a turn.
 *
 * @module session/session-page
 */

import { ActivityIcon, MessageSquareIcon } from "lucide-react"
import * as React from "react"
import { getSession, setSessionTarget } from "@/api/client.ts"
import type {
  ChatMessage,
  CredentialInfo,
  ModelRow,
  SessionSummary,
  SetTargetInput,
} from "@/api/types.ts"
import { ChatView } from "@/chat/chat-view.tsx"
import { ContextMeter } from "@/chat/context-meter.tsx"
import { type DecodedMessage, decodeHistory } from "@/chat/history.ts"
import { Button } from "@/components/ui/button"
import { TraceView } from "@/trace/trace-view.tsx"

import { TargetControl } from "./target-control.tsx"
import { runState, useEventLog } from "./use-event-log.ts"

type Loaded =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; session: SessionSummary; initial: DecodedMessage[] }

/** Props of {@link SessionPage}. */
export interface SessionPageProps {
  id: string
  view: "chat" | "trace"
  /** The newest summary from the session list, if it has one. */
  summary?: SessionSummary
  /** The models and stored credentials of the server, for the target control. */
  models?: readonly ModelRow[]
  credentials?: readonly CredentialInfo[]
  onView: (view: "chat" | "trace") => void
  /** A run started or ended: the session list may be stale. */
  onActivity: (active: boolean, finishedRuns: number) => void
}

const NO_MODELS: readonly ModelRow[] = []
const NO_CREDENTIALS: readonly CredentialInfo[] = []

/** The page of one session. Mount it with `key={id}`. */
export function SessionPage({
  id,
  view,
  summary,
  models = NO_MODELS,
  credentials = NO_CREDENTIALS,
  onView,
  onActivity,
}: SessionPageProps) {
  const [loaded, setLoaded] = React.useState<Loaded>({ kind: "loading" })
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  // The summary that the last target change returned, with the list summary
  // that it replaced. It is the newest one until the session list loads again
  // (then `summary` is a new object, and this one is not used).
  const [changed, setChanged] = React.useState<
    { replaced: SessionSummary | undefined; session: SessionSummary } | undefined
  >(undefined)
  const log = useEventLog(id)
  const run = React.useMemo(() => runState(log.entries), [log.entries])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const detail = await getSession(id)
        if (cancelled) return
        if (detail === null) {
          setLoaded({ kind: "missing" })
          return
        }
        const initial = await decodeHistory(detail.history)
        if (!cancelled) setLoaded({ kind: "ready", session: detail.session, initial })
      } catch (error) {
        if (!cancelled)
          setLoaded({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  React.useEffect(
    () => onActivity(run.active, run.finishedRuns),
    [run.active, run.finishedRuns, onActivity],
  )

  const onTarget = React.useCallback(
    async (input: SetTargetInput) => {
      setChanged({ replaced: summary, session: await setSessionTarget(id, input) })
      // The session list has the old target: load it again.
      onActivity(run.active, run.finishedRuns)
    },
    [id, summary, onActivity, run.active, run.finishedRuns],
  )

  if (loaded.kind === "loading")
    return <p className="p-6 text-sm text-muted-foreground">Loading&hellip;</p>
  if (loaded.kind === "missing") {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No session {id}. Sessions are in memory only unless MA_WEB_PERSIST_DIR is set, so they are
        gone after a server restart.
      </p>
    )
  }
  if (loaded.kind === "error")
    return <p className="p-6 text-sm text-destructive">{loaded.message}</p>

  const session =
    changed !== undefined && changed.replaced === summary
      ? changed.session
      : (summary ?? loaded.session)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
        <div className="mr-auto flex min-w-0 flex-col">
          <h1 className="truncate font-medium" data-testid="session-title">
            {session.title}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {session.id} · {session.model} · {session.mode}
          </p>
        </div>
        <TargetControl
          target={session}
          models={models}
          credentials={credentials}
          onChange={onTarget}
        />
        <ContextMeter messages={messages} limit={session.contextWindow} />
        <div className="flex gap-1" role="tablist" aria-label="Session view">
          <Button
            role="tab"
            aria-selected={view === "chat"}
            variant={view === "chat" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onView("chat")}
          >
            <MessageSquareIcon />
            Chat
          </Button>
          <Button
            role="tab"
            aria-selected={view === "trace"}
            variant={view === "trace" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => onView("trace")}
          >
            <ActivityIcon />
            Trace
          </Button>
        </div>
      </header>
      <div className={view === "chat" ? "flex min-h-0 flex-1 flex-col pt-2" : "hidden"}>
        <ChatView
          key={id}
          sessionId={id}
          initial={loaded.initial}
          runActive={run.active}
          finishedRuns={run.finishedRuns}
          onMessages={setMessages}
        />
      </div>
      {view === "trace" && <TraceView log={log} />}
    </div>
  )
}
