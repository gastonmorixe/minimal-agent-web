/**
 * The real, core-backed session backend (spec v2 section 2.3, S53).
 *
 * `RuntimeBackend` implements {@link SessionBackend} on one `createRuntime`
 * instance (core S47/S48): `createSession` → `runtime.openSession`,
 * `startTurn` → `session.run`, `subscribe` → `session.subscribe`, `answer` →
 * `session.answer`, `abort` → `session.abort`. It replaces the S52
 * `FakeBackend` / `core-mirror/` scaffolding: the event and `SessionEntry`
 * shapes are now core's real, exported ones
 * (`@minimal-agent/core/sdk/events`, `@minimal-agent/core`), not a
 * hand-maintained guess.
 *
 * One `Runtime` per server process (module-level state owned by THIS
 * server, not by core — core itself stays free of module singletons, as
 * its docs require). `runtime-backend.test.ts` and `api.test.ts` each
 * build their own `RuntimeBackend`, so tests never share one `Runtime`.
 *
 * ## Two modes (WEB-PLUGINS-001)
 *
 * **Provider mode** (the default for `bun run start`). `main.ts` calls
 * core's `bootHost()` (`@minimal-agent/core/host-kit/host-boot`) once at
 * process start and passes the {@link BootedHost} here as
 * {@link RuntimeBackendOptions.host}. Each session then gets:
 *
 * - real credentials from `host.resolveAuth(model, providerId)`, with the
 *   provider of the model row, so a model id that two providers register
 *   gets the auth of the right one,
 * - the host's `toolRegistry`, its own tool executor from
 *   `host.toolExecutorFor(model)` (core tools, then plugin tools, with the
 *   media context of its model), and a lifecycle port on the plugin hooks,
 * - no `sendFn`, so core sends through the registered provider plugin,
 * - the context window of the model's {@link ModelRow}.
 *
 * Tools run in the server process, with its working directory. So each
 * session's `cwd` (in its summary and its persisted `meta` record) is
 * `process.cwd()`. A client `cwd` that resolves to another directory is
 * refused with `cwd_mismatch`: the server cannot run tools there.
 *
 * **Scripted mode** (`MA_WEB_SCRIPTED=1` in `main.ts`, and the tests that
 * pass no `host`). Every session gets `transport/scripted-transport.ts` as
 * its `sendFn`: a deterministic, keyword-scripted transport that drives the
 * real `AgentCore` loop (real events, real retry/backoff, real
 * permanent-pause) with no network call and no tools. The session uses
 * {@link SCRIPTED_MODEL} and placeholder credentials that the transport
 * never reads. Each session gets its own transport instance
 * (`RuntimeBackendOptions.sendFn` is a factory, called once per
 * `createSession`): the scripted transport's retry/quota attempt counters
 * are per-instance, so two sessions that share one instance would corrupt
 * each other's scripted retry counts.
 *
 * {@link RuntimeBackend.transport} tells the routes which mode runs, so the
 * app shows the scripted banner only in scripted mode.
 *
 * @module backend/runtime-backend
 */

import { resolve } from "node:path"

import {
  createRuntime,
  type OpenSessionOptions,
  type Runtime,
  type Session,
  type SessionEntry,
  type SubscribeOptions,
} from "@minimal-agent/core"
import type { BootedHost, ModelRow } from "@minimal-agent/core/host-kit/host-boot"
import { createLifecyclePort } from "@minimal-agent/core/host-kit/lifecycle-port-adapter"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import {
  BackendError,
  type CreateSessionInput,
  type ModelList,
  type SessionBackend,
  type SessionStatus,
  type SessionSummary,
  type TransportInfo,
  type TurnHandle,
} from "./backend.ts"
import { assistantMessageId } from "./history.ts"
import { createScriptedTransport, type ScriptedTransport } from "./transport/scripted-transport.ts"

/** Options for {@link RuntimeBackend}. */
export interface RuntimeBackendOptions {
  /**
   * The booted host (provider mode). Each session uses its auth, tools,
   * and model rows. Leave it out for scripted mode. See the module doc.
   */
  host?: BootedHost
  /**
   * Scripted mode only. Builds the transport one session's `AgentCore`
   * sends through. Called once per {@link createSession} call, never shared
   * between sessions: the scripted transport's retry/quota attempt counters
   * are per-instance (see `transport/scripted-transport.ts`), and two
   * sessions sharing one instance would corrupt each other's counts
   * (confirmed: two concurrent "retry" turns on a shared instance
   * interleave their attempt counts). Default: a fresh
   * {@link createScriptedTransport} per session. Not allowed with `host`.
   */
  sendFn?: () => ScriptedTransport
  /** Persist sessions to disk (core's real `SessionStore` + durable event log). Default: memory only. */
  persistDir?: string
  /**
   * Retry backoff ceiling for every session, in ms. Default
   * {@link DEFAULT_RETRY_CEILING_MS}: core's own default (60 s) is tuned for
   * a real network call, far too slow for the scripted "retry" / "quota"
   * demo scripts to stay interactive. Lower further for fast tests.
   */
  retryCeilingMs?: number
  /** Clock for entry timestamps. Default `Date.now`. */
  now?: () => number
}

/** Scripted mode only. Placeholder credentials: the scripted transport never reads them. */
const PLACEHOLDER_AUTH = { type: "api-key" as const, token: "unused-scripted-transport" }

/** Default {@link RuntimeBackendOptions.retryCeilingMs}: fast enough to stay interactive. */
export const DEFAULT_RETRY_CEILING_MS = 300

/** Scripted mode only. A model id with no registry entry behind it: the scripted transport answers regardless. */
export const SCRIPTED_MODEL = "scripted-test-model"

/** Scripted mode only. No model row exists, so this is a display-only placeholder. */
export const PLACEHOLDER_CONTEXT_WINDOW = 200_000

/** What {@link RuntimeBackend.transport} says in scripted mode. */
export const SCRIPTED_TRANSPORT: TransportInfo = {
  kind: "scripted",
  description:
    "Every reply is a scripted transport, not a real model provider: see AGENTS.md, " +
    '"Session backend".',
}

/** The parts of one session that differ between the two modes. */
interface ModeSessionParts {
  model: string
  contextWindow: number
  open: Omit<OpenSessionOptions, "id" | "retry" | "persist">
}

const TITLE_LENGTH = 60

/**
 * Time in ms that a preflight `ask_user` waits for `POST .../answers`. Then
 * core resolves it with its default option, or declines it. Decision 11: no
 * human is assumed, so an ask never waits forever.
 */
export const ASK_DEADLINE_MS = 5 * 60_000

interface SessionState {
  summary: Omit<SessionSummary, "status" | "updatedAt" | "title" | "runs">
  title: string | null
  runs: number
  status: SessionStatus
  session: Session
}

function titleFrom(text: string): string {
  return text.trim().slice(0, TITLE_LENGTH) || "Untitled"
}

/** Count of a session's log entries right now, by a synchronous full replay-and-unsubscribe. */
function nextSeqOf(session: Session): number {
  let count = 0
  const unsubscribe = session.subscribe(
    () => {
      count++
    },
    { fromSeq: 0 },
  )
  unsubscribe()
  return count
}

/** Every entry of a session's log right now, oldest first, the same way. */
function wholeLogOf(session: Session): SessionEntry[] {
  const entries: SessionEntry[] = []
  const unsubscribe = session.subscribe((entry) => entries.push(entry), { fromSeq: 0 })
  unsubscribe()
  return entries
}

/**
 * Filter a session's log stream to its `AgentEvent`s (`ch: "event"`),
 * dropping diagnostics.
 *
 * `session.run`'s iterable rethrows at the end of an aborted or otherwise
 * failed turn (core's own doc on `AgentCore.run`: "a fatal non-abort throw
 * is emitted as an `error` event, then rethrown. Either way, `run_finished`
 * closes the run"). By the time that happens, the terminal `error` and
 * `run_finished` entries have already been delivered as ordinary yields —
 * `Session`'s own event log appends them synchronously, before the
 * generator unwinds — so there is nothing left for a reject to carry that
 * the stream does not already have. Swallow it, rather than let it blow up
 * the SSE response the route is writing to.
 */
async function* eventsOnly(entries: AsyncIterable<SessionEntry>): AsyncIterable<AgentEvent> {
  try {
    for await (const entry of entries) if (entry.ch === "event") yield entry.data
  } catch {
    // See the function doc: the meaningful entries already went out.
  }
}

/** What {@link RuntimeBackend.transport} says in provider mode. */
function providerTransport(host: BootedHost): TransportInfo {
  const row = host.models.find((m) => m.id === host.defaultModelId)
  const providerId = row?.providerId ?? host.providers[0] ?? "unknown"
  return {
    kind: "provider",
    providerId,
    description: `Replies come from provider "${providerId}", default model "${host.defaultModelId}".`,
  }
}

/** Find a booted model row by id. */
function findRow(host: BootedHost, modelId: string): ModelRow | undefined {
  return host.models.find((m) => m.id === modelId)
}

/** Provider mode: real auth, host tools, no `sendFn`, and the row's context window. */
async function providerParts(host: BootedHost, modelId: string): Promise<ModeSessionParts> {
  const row = findRow(host, modelId)
  if (row === undefined) {
    throw new BackendError("unknown_model", `no booted provider registers model "${modelId}"`)
  }
  let auth: Awaited<ReturnType<BootedHost["resolveAuth"]>>
  try {
    auth = await host.resolveAuth(row.id, row.providerId)
  } catch (error) {
    // The core message names the provider and the login command. It holds no secret.
    const reason = error instanceof Error ? error.message : String(error)
    throw new BackendError("auth_unavailable", reason)
  }
  return {
    model: row.id,
    contextWindow: row.contextWindow,
    open: {
      model: row.id,
      providerId: row.providerId,
      auth,
      toolRegistry: host.toolRegistry,
      // One executor per session: it carries the model context of this session.
      toolExecutor: host.toolExecutorFor(row.id),
      lifecycle: createLifecyclePort(host.loader.hooks()),
    },
  }
}

/** The real session backend. See the module doc. */
export class RuntimeBackend implements SessionBackend {
  readonly kind = "core"
  /** Which mode runs. See the module doc. */
  readonly transport: TransportInfo
  private readonly runtime: Runtime
  private readonly host: BootedHost | undefined
  private readonly sendFnFactory: () => ScriptedTransport
  private readonly persistDir: string | undefined
  /** The server process cwd: where tools run. Each session records it. */
  private readonly cwd: string
  private readonly retryCeilingMs: number | undefined
  private readonly now: () => number
  private readonly sessions = new Map<string, SessionState>()
  private created = 0

  /**
   * Create the backend. It starts with no sessions.
   *
   * @throws Error when both `host` and `sendFn` are set
   */
  constructor(options: RuntimeBackendOptions = {}) {
    if (options.host !== undefined && options.sendFn !== undefined) {
      throw new Error("RuntimeBackend: sendFn is for scripted mode only; do not pass it with host")
    }
    this.runtime = createRuntime({ now: options.now })
    this.host = options.host
    this.transport = options.host ? providerTransport(options.host) : SCRIPTED_TRANSPORT
    this.sendFnFactory = options.sendFn ?? (() => createScriptedTransport())
    this.persistDir = options.persistDir
    this.cwd = process.cwd()
    this.retryCeilingMs = options.retryCeilingMs ?? DEFAULT_RETRY_CEILING_MS
    this.now = options.now ?? Date.now
  }

  /** The models a session can use, and the default. Scripted mode has no model rows. */
  models(): ModelList {
    if (this.host === undefined) return { models: [], defaultModelId: SCRIPTED_MODEL }
    return { models: [...this.host.models], defaultModelId: this.host.defaultModelId }
  }

  /**
   * Create a session.
   *
   * @throws BackendError `cwd_mismatch` when `input.cwd` resolves to a
   *   directory other than the server cwd
   */
  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    if (input.cwd !== undefined && resolve(this.cwd, input.cwd) !== this.cwd) {
      throw new BackendError(
        "cwd_mismatch",
        `cwd must be the server cwd (${this.cwd}): tools run there, not in ${input.cwd}`,
      )
    }
    const parts =
      this.host === undefined
        ? this.scriptedParts(input)
        : await providerParts(this.host, input.model ?? this.host.defaultModelId)
    this.created++
    const id = `session-${this.created}`
    const session = this.runtime.openSession({
      id,
      ...parts.open,
      // The web UI answers asks through `session.answer` (`answer()` below).
      askUserFallback: "registry",
      askDeadlineMs: ASK_DEADLINE_MS,
      ...(this.retryCeilingMs !== undefined ? { retry: { ceilingMs: this.retryCeilingMs } } : {}),
      ...(this.persistDir !== undefined
        ? { persist: { dir: this.persistDir, cwd: this.cwd } }
        : {}),
    })
    const state: SessionState = {
      summary: {
        id,
        model: parts.model,
        cwd: this.cwd,
        mode: input.mode ?? "default",
        contextWindow: parts.contextWindow,
        createdAt: this.now(),
      },
      title: null,
      runs: 0,
      status: "idle",
      session,
    }
    this.sessions.set(id, state)
    return this.summarize(state)
  }
  /** Every session, newest first. */
  listSessions(): Promise<SessionSummary[]> {
    return Promise.resolve(
      [...this.sessions.values()].map((state) => this.summarize(state)).reverse(),
    )
  }

  /** One session, or `undefined`. */
  getSession(id: string): Promise<SessionSummary | undefined> {
    const state = this.sessions.get(id)
    return Promise.resolve(state === undefined ? undefined : this.summarize(state))
  }

  /** Start a turn. */
  startTurn(id: string, input: { text: string }): Promise<TurnHandle> {
    const state = this.require(id)
    if (state.status !== "idle") {
      return Promise.reject(new BackendError("busy", `session ${id} is running a turn`))
    }
    state.title ??= titleFrom(input.text)
    state.runs++
    state.status = "running"
    const startSeq = nextSeqOf(state.session)

    // Track status from the session's own log, independent of whether the
    // HTTP route keeps reading `events` below (a client that goes away does
    // not stop the run — spec 4.2 — and must not strand the status either).
    const unsubscribe = state.session.subscribe(
      (entry) => {
        if (entry.ch !== "event") return
        if (entry.data.type === "ask_user") state.status = "waiting"
        else if (entry.data.type === "run_finished") {
          state.status = "idle"
          unsubscribe()
        }
      },
      { fromSeq: startSeq },
    )

    const events = state.session.run(input.text, { emitDeltas: true })
    return Promise.resolve({ messageId: assistantMessageId(startSeq), events: eventsOnly(events) })
  }

  /** Subscribe to a session's log. */
  subscribe(
    id: string,
    listener: (entry: SessionEntry) => void,
    options: SubscribeOptions = {},
  ): () => void {
    return this.require(id).session.subscribe(listener, options)
  }

  /** Answer the pending ask. */
  answer(id: string, askId: string, answer: string | null): void {
    const ok = this.require(id).session.answer(askId, answer)
    if (!ok) throw new BackendError("no_such_ask", `no pending ask ${askId} in session ${id}`)
  }

  /** Abort the current run. */
  abort(id: string, reason?: string): boolean {
    const state = this.require(id)
    if (state.status === "idle") return false
    state.session.abort(reason ?? "aborted")
    return true
  }

  /** Close the runtime: every open session stops. */
  close(): void {
    this.runtime.close()
  }

  /** Scripted mode: the scripted transport, placeholder auth and context window. */
  private scriptedParts(input: CreateSessionInput): ModeSessionParts {
    const model = input.model ?? SCRIPTED_MODEL
    return {
      model,
      contextWindow: PLACEHOLDER_CONTEXT_WINDOW,
      open: { model, auth: PLACEHOLDER_AUTH, sendFn: this.sendFnFactory() },
    }
  }

  private require(id: string): SessionState {
    const state = this.sessions.get(id)
    if (state === undefined) throw new BackendError("not_found", `no session ${id}`)
    return state
  }

  private summarize(state: SessionState): SessionSummary {
    return {
      ...state.summary,
      title: state.title ?? "New session",
      updatedAt: wholeLogOf(state.session).at(-1)?.ts ?? state.summary.createdAt,
      status: state.status,
      runs: state.runs,
    }
  }
}
