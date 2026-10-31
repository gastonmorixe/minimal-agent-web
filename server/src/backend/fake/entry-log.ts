/**
 * The fake backend's session event log: an in-memory copy of the rules of
 * core's `SessionEventLog` (S48) that the routes rely on.
 *
 * - `seq` starts at 0 and grows by one per entry.
 * - `subscribe` with `fromSeq` replays synchronously, then streams live
 *   entries. Without `fromSeq` it streams live entries only.
 * - A listener that throws is isolated: the others still get the entry.
 * - Every listener sees entries in `seq` order, exactly once, even when a
 *   listener appends from inside its callback.
 *
 * No ring buffer and no durable file: the fake keeps every entry in memory
 * for the life of the process.
 *
 * @module backend/fake/entry-log
 */

import type { WebAgentEvent } from "../../core-mirror/events.ts"
import {
  type DiagnosticEvent,
  SESSION_ENTRY_VERSION,
  type SessionEntry,
  type SessionEntryListener,
  type Unsubscribe,
} from "../../core-mirror/session-entry.ts"

interface Subscriber {
  listener: SessionEntryListener
  /** Next seq this subscriber may get. */
  cursor: number
}

/** One session's log. */
export class EntryLog {
  private readonly entries: SessionEntry[] = []
  private readonly subscribers = new Set<Subscriber>()
  private readonly pending: SessionEntry[] = []
  private delivering = false

  /** Create the log. `now` stamps each entry's `ts`. */
  constructor(
    readonly sessionId: string,
    private readonly now: () => number,
  ) {}

  /** The seq the next entry gets. */
  get nextSeq(): number {
    return this.entries.length
  }

  /** Time of the last entry, if any. */
  get lastTs(): number | undefined {
    return this.entries.at(-1)?.ts
  }

  /** Append an agent event. */
  appendEvent(data: WebAgentEvent): SessionEntry {
    return this.commit({ ...this.base(), ch: "event", data })
  }

  /** Append a diagnostic. */
  appendDiag(data: DiagnosticEvent): SessionEntry {
    return this.commit({ ...this.base(), ch: "diag", data })
  }

  /** Every entry, oldest first. */
  all(): readonly SessionEntry[] {
    return this.entries
  }

  /** Subscribe. With `fromSeq`, the replay runs before this returns. */
  subscribe(listener: SessionEntryListener, fromSeq?: number): Unsubscribe {
    const sub: Subscriber = { listener, cursor: Math.min(fromSeq ?? this.nextSeq, this.nextSeq) }
    this.subscribers.add(sub)
    if (fromSeq !== undefined) {
      const outer = this.delivering
      this.delivering = true
      try {
        for (const entry of this.entries.slice(sub.cursor)) this.deliver(sub, entry)
      } finally {
        this.delivering = outer
      }
      this.drain()
    }
    return () => {
      this.subscribers.delete(sub)
    }
  }

  private base() {
    return {
      v: SESSION_ENTRY_VERSION,
      seq: this.entries.length,
      ts: this.now(),
      sessionId: this.sessionId,
    } as const
  }

  private commit(entry: SessionEntry): SessionEntry {
    this.entries.push(entry)
    this.pending.push(entry)
    this.drain()
    return entry
  }

  private drain(): void {
    if (this.delivering) return
    this.delivering = true
    try {
      for (let i = 0; i < this.pending.length; i++) {
        const entry = this.pending[i]
        if (entry === undefined) continue
        for (const sub of this.subscribers) this.deliver(sub, entry)
      }
    } finally {
      this.pending.length = 0
      this.delivering = false
    }
  }

  private deliver(sub: Subscriber, entry: SessionEntry): void {
    if (!this.subscribers.has(sub) || entry.seq < sub.cursor) return
    sub.cursor = entry.seq + 1
    try {
      sub.listener(entry)
    } catch {
      // Isolated (S22). Core reports the first throw as `events.sink-error`;
      // the fake has no listener that throws on purpose.
    }
  }
}
