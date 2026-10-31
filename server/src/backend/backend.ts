/**
 * The session backend: what the HTTP routes of spec 4.2 need from an agent.
 *
 * `RuntimeBackend` (`runtime-backend.ts`) is the one implementation, on
 * `createRuntime` / `openSession` (core S47, S53). Each method maps to one
 * core call: `createSession` to `runtime.openSession`, `startTurn` to
 * `session.run`, `subscribe` to `session.subscribe`, `answer` to
 * `session.answer`, `abort` to `session.abort`. See its module doc for the
 * two scope decisions it documents (no tools, a server-supplied transport
 * instead of a real model provider).
 *
 * Methods throw {@link BackendError} (async methods reject with it) for an
 * unknown session, a busy session, or an unknown ask. The routes turn its
 * `code` into an HTTP status.
 *
 * @module backend/backend
 */

import type { SessionEntryListener, SubscribeOptions, Unsubscribe } from "@minimal-agent/core"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

/** Which implementation answers the API. Always `"core"`; the app no longer shows a fake-backend banner. */
export type BackendKind = "core"

/** What `POST /api/sessions` accepts. Every field is optional. */
export interface CreateSessionInput {
  model?: string
  cwd?: string
  mode?: string
}

/** What a session is doing now. */
export type SessionStatus = "idle" | "running" | "waiting"

/** One session, as `GET /api/sessions` lists it. */
export interface SessionSummary {
  id: string
  /** The first user message, shortened, or "New session". */
  title: string
  model: string
  cwd: string
  mode: string
  /** A placeholder context window in tokens, for the Context element: no model registry is wired (see `runtime-backend.ts`). */
  contextWindow: number
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms of the last log entry. */
  updatedAt: number
  status: SessionStatus
  /** Runs started so far. */
  runs: number
}

/** A turn the backend started. */
export interface TurnHandle {
  /** Id of the assistant message this turn produces. */
  messageId: string
  /**
   * The run's events, from its `user_message` to its `run_finished`. The run
   * goes on when a consumer stops reading: only {@link SessionBackend.abort}
   * stops it.
   */
  events: AsyncIterable<AgentEvent>
}

/** The session backend. See the module doc. */
export interface SessionBackend {
  readonly kind: BackendKind
  /** Create a session. */
  createSession(input: CreateSessionInput): Promise<SessionSummary>
  /** Every session, newest first. */
  listSessions(): Promise<SessionSummary[]>
  /** One session, or `undefined` when there is none with this id. */
  getSession(id: string): Promise<SessionSummary | undefined>
  /** Start a turn with the person's message. Throws `busy` while a turn runs. */
  startTurn(id: string, input: { text: string }): Promise<TurnHandle>
  /**
   * Subscribe to a session's event log. With `fromSeq`, the replay runs
   * synchronously before this returns, as in core, so `fromSeq: 0` and an
   * immediate unsubscribe read the whole log.
   */
  subscribe(id: string, listener: SessionEntryListener, options?: SubscribeOptions): Unsubscribe
  /**
   * Answer a pending `ask_user` with the id of the chosen
   * {@link AskUserEvent.options} entry, or `null` to decline. Throws
   * `no_such_ask` when it is not pending.
   */
  answer(id: string, askId: string, answer: string | null): void
  /** Abort the current turn. Returns false when no turn runs. */
  abort(id: string, reason?: string): boolean
  /** Stop every run and timer. */
  close(): void
}

/**
 * Why a backend call failed: no such session, a turn already runs, or no
 * such pending ask.
 */
export type BackendErrorCode = "not_found" | "busy" | "no_such_ask"

/** A backend call failed for a reason the caller can act on. */
export class BackendError extends Error {
  /** Create the error. */
  constructor(
    readonly code: BackendErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "BackendError"
  }
}
