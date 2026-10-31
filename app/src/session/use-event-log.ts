/**
 * React hook over {@link subscribeEventLog}: every entry of a session's event
 * log, in seq order, live. Entries are batched into one state update per
 * frame, so a replay of thousands of entries renders once, not thousands of
 * times.
 *
 * @module session/use-event-log
 */

import * as React from "react"
import { type EventLogState, subscribeEventLog } from "@/api/event-log.ts"
import type { SessionEntry } from "@/api/types.ts"

/** The log so far and the connection state. */
export interface EventLogView {
  entries: readonly SessionEntry[]
  state: EventLogState
}

/** Subscribe to a session's event log for the life of the component. Key the component by session. */
export function useEventLog(sessionId: string): EventLogView {
  const [view, setView] = React.useState<EventLogView>({ entries: [], state: "connecting" })
  React.useEffect(() => {
    let pending: SessionEntry[] = []
    let frame: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      frame = null
      const batch = pending
      pending = []
      setView((current) => ({ ...current, entries: [...current.entries, ...batch] }))
    }
    const stop = subscribeEventLog(sessionId, {
      onEntry: (entry) => {
        pending.push(entry)
        frame ??= setTimeout(flush, 16)
      },
      onState: (state) => setView((current) => ({ ...current, state })),
    })
    return () => {
      stop()
      if (frame !== null) clearTimeout(frame)
    }
  }, [sessionId])
  return view
}

/** Run state from the log: a run is active between its `user_message` and its `run_finished`. */
export interface RunState {
  active: boolean
  /** Seq of the last `run_finished`, or -1. */
  lastFinishedSeq: number
  /** `run_finished` entries so far. */
  finishedRuns: number
}

/** Derive {@link RunState} from the entries. */
export function runState(entries: readonly SessionEntry[]): RunState {
  let active = false
  let lastFinishedSeq = -1
  let finishedRuns = 0
  for (const entry of entries) {
    if (entry.ch !== "event") continue
    if (entry.data.type === "user_message") active = true
    else if (entry.data.type === "run_finished") {
      active = false
      lastFinishedSeq = entry.seq
      finishedRuns++
    }
  }
  return { active, lastFinishedSeq, finishedRuns }
}
