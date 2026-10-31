/**
 * The session list: every session, newest first, and a button for a new one.
 *
 * @module session/session-list
 */

import { PlusIcon } from "lucide-react"
import type { SessionSummary } from "@/api/types.ts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

/** Props of {@link SessionList}. */
export interface SessionListProps {
  sessions: readonly SessionSummary[]
  activeId: string | null
  onOpen: (id: string) => void
  onCreate: () => void
  creating: boolean
}

/** The sidebar list of sessions. */
export function SessionList({ sessions, activeId, onOpen, onCreate, creating }: SessionListProps) {
  return (
    <nav className="flex min-h-0 flex-col gap-2" aria-label="Sessions">
      <Button onClick={onCreate} disabled={creating} size="sm" data-testid="new-session">
        <PlusIcon />
        New session
      </Button>
      {sessions.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No sessions yet.</p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-1 overflow-auto">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => onOpen(session.id)}
                aria-current={session.id === activeId ? "page" : undefined}
                data-testid="session-item"
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted aria-[current=page]:bg-muted"
              >
                <span className="truncate font-medium">{session.title}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {session.id}
                  {session.status !== "idle" && <Badge variant="secondary">{session.status}</Badge>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
