/**
 * The session event log entry (spec 2.4, S48).
 *
 * MIRROR, NOT OURS. Core main has this shape in `src/session/event-log.ts`
 * (`SessionEntry`, `serializeEntrySse`), but core does not export it yet, and
 * the web pin predates it. S53 deletes this file and imports the type and the
 * serializer from core's public exports. Keep the shape identical until then.
 *
 * @module core-mirror/session-entry
 */

import type { WebAgentEvent } from "./events.ts"

/** Version of the entry shape. */
export const SESSION_ENTRY_VERSION = 1

/** RFC 5424 severity, as core's `Severity`. Lower number = more severe. */
export const Severity = {
  Emergency: 0,
  Alert: 1,
  Critical: 2,
  Error: 3,
  Warning: 4,
  Notice: 5,
  Info: 6,
  Debug: 7,
} as const

/** One of the {@link Severity} values. */
export type Severity = (typeof Severity)[keyof typeof Severity]

/** RFC 5424 facility number, as core's `Facility`. `1` is `User`. */
export type Facility = number

/** The two channels of a session log. */
export type SessionChannel = "event" | "diag"

/** One diagnostic in the session log (`ch: "diag"`). */
export interface DiagnosticEvent {
  readonly severity: Severity
  readonly facility: Facility
  /** Dotted-kebab id, e.g. `events.sink-error`. */
  readonly code: string
  readonly message: string
  readonly data?: Readonly<Record<string, string | number | boolean>>
}

interface SessionEntryBase {
  readonly v: typeof SESSION_ENTRY_VERSION
  /** Position in the session log. Starts at 0, grows by one. */
  readonly seq: number
  /** Append time, epoch ms. */
  readonly ts: number
  readonly sessionId: string
}

/** An agent event in the session log. */
export interface SessionEventEntry extends SessionEntryBase {
  readonly ch: "event"
  readonly data: WebAgentEvent
}

/** A diagnostic in the session log. */
export interface SessionDiagEntry extends SessionEntryBase {
  readonly ch: "diag"
  readonly data: DiagnosticEvent
}

/** One entry of the session log. This is also the wire format. */
export type SessionEntry = SessionEventEntry | SessionDiagEntry

/** Receives entries from a subscription. */
export type SessionEntryListener = (entry: SessionEntry) => void

/** Stops a subscription. Calling it again does nothing. */
export type Unsubscribe = () => void

/**
 * One entry as one SSE event: `id: <seq>`, then one `data:` line. The browser
 * sends the last id back as `Last-Event-ID`; resume from that seq plus one.
 * Same text as core's `serializeEntrySse`.
 */
export function serializeEntrySse(entry: SessionEntry): string {
  return `id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`
}
