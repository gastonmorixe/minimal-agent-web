/**
 * The session backend: what the HTTP routes of spec 4.2 need from an agent.
 *
 * `RuntimeBackend` (`runtime-backend.ts`) is the one implementation, on
 * `createRuntime` / `openSession` (core S47, S53). Each method maps to one
 * core call: `createSession` to `runtime.openSession`, `startTurn` to
 * `session.run`, `subscribe` to `session.subscribe`, `answer` to
 * `session.answer`, `abort` to `session.abort`, `setTarget` to
 * `AgentCore.switchTarget` of that session. See its module doc for its
 * two modes: provider mode (a booted host with real auth and tools) and
 * scripted mode (`MA_WEB_SCRIPTED=1`, a scripted transport).
 *
 * Methods throw {@link BackendError} (async methods reject with it) for an
 * unknown session, a busy session, an unknown ask, an unknown model, a
 * model with no credentials, a target that the host does not have, or a
 * client `cwd` that is not the server cwd.
 * The routes turn its
 * `code` into an HTTP status.
 *
 * @module backend/backend
 */

import type { SessionEntryListener, SubscribeOptions, Unsubscribe } from "@minimal-agent/core"
import type { ModelRow } from "@minimal-agent/core/host-kit/host-boot"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

/** Which implementation answers the API. Always `"core"`; the app no longer shows a fake-backend banner. */
export type BackendKind = "core"

/**
 * What `GET /api/sessions` and `GET /api/sessions/:id` say about the model
 * transport. `provider`: a booted provider plugin answers. `scripted`: the
 * scripted transport answers (`MA_WEB_SCRIPTED=1`), not a real model.
 */
export type TransportInfo =
  | { kind: "provider"; providerId: string; description: string }
  | { kind: "scripted"; description: string }

/** One stored credential a session can use. */
export interface CredentialInfo {
  providerId: string
  displayName: string
  authKind: "oauth" | "api-key"
  credentialName: string
  credentialLabel: string
  /** Whether the stored credential decodes into runtime auth. */
  usable: boolean
}

/** What `GET /api/models` returns. */
export interface ModelList {
  /** Booted model rows. Empty in scripted mode. */
  models: ModelRow[]
  /** Kept for compat. The server picks no default: each session names its model. @deprecated Use the models list; each session names its model. */
  defaultModelId: string
  /** Stored credentials by provider. Empty in scripted mode. */
  credentials: CredentialInfo[]
}

/** What `POST /api/sessions` accepts. `model` is required in provider mode. */
export interface CreateSessionInput {
  model?: string
  /** Scope the model row and auth to this provider when set. */
  providerId?: string
  /** Select one stored credential of the provider when set. */
  credentialName?: string
  /** Must resolve to the server cwd when set: tools run there. Else `cwd_mismatch`. */
  cwd?: string
  mode?: string
  /** Reasoning effort: one of the levels of the model. Absent: the model default. */
  effort?: string
}

/**
 * What `POST /api/sessions/:id/target` accepts: the values to change. An
 * absent value stays as it is, with one exception: a change of
 * `providerId` with no `credentialName` uses the default credential of the
 * new provider. A change of `providerId` needs a `model` of that provider.
 */
export interface SetTargetInput {
  /** A stored credential of the provider, by name. Never a token or a key. */
  credentialName?: string
  providerId?: string
  model?: string
  /** A level of the model, or `null` for the model default. */
  effort?: string | null
}

/** What a session is doing now. */
export type SessionStatus = "idle" | "running" | "waiting"

/** One session, as `GET /api/sessions` lists it. */
export interface SessionSummary {
  id: string
  /** The first user message, shortened, or "New session". */
  title: string
  /** The live model: a target change updates it. */
  model: string
  /** The live provider. Absent in scripted mode. */
  providerId?: string
  /** The live credential name. Absent for the default credential of the provider. */
  credentialName?: string
  /** The live reasoning effort. Absent for the model default. */
  effort?: string
  /** The server process cwd: where the session's tools run. */
  cwd: string
  mode: string
  /** Context window in tokens of the live model, for the Context element. From the model row, or a placeholder in scripted mode. */
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
  /** Which transport answers. */
  readonly transport: TransportInfo
  /** The models a session can use, and the default. */
  models(): ModelList
  /** Create a session. Rejects with `unknown_model`, `auth_unavailable`, or `cwd_mismatch`. */
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
  /**
   * Change the target of ONE session: its credential, provider, model and
   * effort. It applies at once, also while a turn runs or waits for a retry
   * or a quota reset: the turn continues with the new target and is not
   * aborted. No other session changes. Rejects with `not_found`,
   * `bad_target`, `unknown_credential`, `unknown_model` or
   * `auth_unavailable`; then nothing changed.
   */
  setTarget(id: string, input: SetTargetInput): Promise<SessionSummary>
  /** Stop every run and timer. */
  close(): void
}

/**
 * Why a backend call failed: no such session, a turn already runs, no such
 * pending ask, no such model, a credentialName with no providerId, no such
 * stored credential, no credentials for the model, a target that cannot be
 * set (`bad_target`: an effort that the model does not have, a switch that
 * the core refuses, or scripted mode), or a client `cwd` that is not the
 * server cwd.
 */
export type BackendErrorCode =
  | "not_found"
  | "busy"
  | "no_such_ask"
  | "unknown_model"
  | "credential_needs_provider"
  | "unknown_credential"
  | "auth_unavailable"
  | "cwd_mismatch"
  | "bad_target"

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
