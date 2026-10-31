/**
 * The session backend: what the HTTP routes of spec 4.2 need from an agent.
 *
 * The routes in `api/routes.ts` talk only to this interface. Two
 * implementations are planned:
 *
 * - `FakeBackend` (`fake/fake-backend.ts`), today's default. In memory and
 *   deterministic: it replays canned core event sequences. It never calls a
 *   model. For development and tests only.
 * - A core-backed backend (S53) on `createRuntime` / `openSession` (S47). It
 *   replaces the fake as the default. Each method maps to one core call:
 *   `createSession` to `runtime.openSession`, `startTurn` to `session.run`,
 *   `subscribe` to `session.subscribe`, `answer` to `session.answer`, `abort`
 *   to `session.abort`.
 *
 * Methods throw {@link BackendError} (async methods reject with it) for an
 * unknown session, a busy session, or an unknown ask. The routes turn its
 * `code` into an HTTP status.
 *
 * @module backend/backend
 */

import type { AskAnswer, WebAgentEvent } from "../core-mirror/events.ts"
import type { SessionEntryListener, Unsubscribe } from "../core-mirror/session-entry.ts"

/** Which implementation answers the API. The app shows it, so a fake is never taken for an agent. */
export type BackendKind = "fake" | "core"

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
  /** The model's context window in tokens, for the Context element. */
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
  events: AsyncIterable<WebAgentEvent>
}

/** Options for {@link SessionBackend.subscribe}, as core's `session.subscribe` takes them. */
export interface SubscribeOptions {
  /** Replay from this seq, then stream live entries. Absent: live entries only. */
  fromSeq?: number
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
  /** Answer a pending `ask_user`. Throws `no_such_ask` when it is not pending. */
  answer(id: string, askId: string, answer: AskAnswer): void
  /** Abort the current turn. Returns false when no turn runs. */
  abort(id: string, reason?: string): boolean
  /** Stop every run and timer. */
  close(): void
}

/**
 * Why a backend call failed: no such session, a turn already runs, no such
 * pending ask, or an answer of the wrong kind.
 */
export type BackendErrorCode = "not_found" | "busy" | "no_such_ask" | "invalid"

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
