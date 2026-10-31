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
 * ## Two scope decisions for S53
 *
 * **No tools.** `runtime.openSession` is called with no `toolRegistry` /
 * `toolExecutor`. Core's own docs call this out explicitly
 * (`src/runtime/build-core.ts`, `src/runtime/noop-tools.ts`): a runtime
 * session with neither runs a plain, tool-free turn. Rebuilding the CLI's
 * tool catalog (its plugin loader, its built-in tools, its tool-approval UI)
 * is a separate, much larger piece of host work, explicitly out of this
 * spec's scope. `tool_call` / `tool_output` / `tool_result` stay fully
 * wired in the chat-stream adapter and the trace view — they are real,
 * stable kinds of `AgentEvent` — they simply never fire with today's
 * sessions. A later spec that wants tools passes `toolRegistry` /
 * `toolExecutor` to {@link createSession} without touching anything else
 * downstream.
 *
 * **No real model provider.** Resolving a model to a provider adapter
 * (`src/llm/run.ts` in core) needs a provider PLUGIN registered — core ships
 * none; that is explicitly host/CLI territory
 * (`src/host/startup/provider-discovery-boot.ts`, which scans the sibling
 * `minimal-agent-plugins` repo). Loading plugins here would add a second
 * runtime dependency and reimplement a chunk of the CLI's boot sequence,
 * both out of scope (AGENTS.md: the server has one runtime dependency,
 * `@minimal-agent/core`). So every session gets `transport/scripted-transport.ts`
 * as its `sendFn` instead: a deterministic, keyword-scripted transport that
 * drives the REAL `AgentCore` loop (real events, real retry/backoff, real
 * permanent-pause) without a network call. This is "core-backed", not
 * "model-backed" — the gap is the model provider, not the session/event
 * pipeline, and it is the same gap for every caller of a bare
 * `createRuntime` today, CLI included, until that caller does its own
 * provider-plugin wiring. `GET /api/sessions` and `GET /api/sessions/:id`
 * report `transport: "scripted"` so the app can say this plainly instead of
 * implying a real model answers.
 *
 * @module backend/runtime-backend
 */

import {
  createRuntime,
  type Runtime,
  type Session,
  type SessionEntry,
  type SubscribeOptions,
} from "@minimal-agent/core"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import {
  BackendError,
  type CreateSessionInput,
  type SessionBackend,
  type SessionStatus,
  type SessionSummary,
  type TurnHandle,
} from "./backend.ts"
import { assistantMessageId } from "./history.ts"
import { createScriptedTransport, type ScriptedTransport } from "./transport/scripted-transport.ts"

/** Options for {@link RuntimeBackend}. */
export interface RuntimeBackendOptions {
  /** The transport every session's `AgentCore` sends through. Default: a fresh scripted transport. */
  sendFn?: ScriptedTransport
  /** Persist sessions to disk (core's real `SessionStore` + durable event log). Default: memory only. */
  persistDir?: string
  /** `cwd` recorded in each session's `meta` record, when persisting. */
  cwd?: string
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

/** Placeholder credentials: the scripted transport never reads them. */
const PLACEHOLDER_AUTH = { type: "api-key" as const, token: "unused-scripted-transport" }

/** Default {@link RuntimeBackendOptions.retryCeilingMs}: fast enough to stay interactive. */
export const DEFAULT_RETRY_CEILING_MS = 300

/** A model id with no registry entry behind it: the scripted transport answers regardless. */
export const SCRIPTED_MODEL = "scripted-test-model"

/** No model capabilities are registered (no provider plugin loaded); this is a display-only placeholder. */
export const PLACEHOLDER_CONTEXT_WINDOW = 200_000

const TITLE_LENGTH = 60

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

/** The real session backend. See the module doc. */
export class RuntimeBackend implements SessionBackend {
  readonly kind = "core"
  private readonly runtime: Runtime
  private readonly sendFn: ScriptedTransport
  private readonly persistDir: string | undefined
  private readonly cwd: string | undefined
  private readonly retryCeilingMs: number | undefined
  private readonly now: () => number
  private readonly sessions = new Map<string, SessionState>()
  private created = 0

  /** Create the backend. It starts with no sessions. */
  constructor(options: RuntimeBackendOptions = {}) {
    this.runtime = createRuntime({ now: options.now })
    this.sendFn = options.sendFn ?? createScriptedTransport()
    this.persistDir = options.persistDir
    this.cwd = options.cwd
    this.retryCeilingMs = options.retryCeilingMs ?? DEFAULT_RETRY_CEILING_MS
    this.now = options.now ?? Date.now
  }

  /** Create a session. */
  createSession(input: CreateSessionInput): Promise<SessionSummary> {
    this.created++
    const id = `session-${this.created}`
    const model = input.model ?? SCRIPTED_MODEL
    const session = this.runtime.openSession({
      id,
      model,
      auth: PLACEHOLDER_AUTH,
      sendFn: this.sendFn,
      ...(this.retryCeilingMs !== undefined ? { retry: { ceilingMs: this.retryCeilingMs } } : {}),
      ...(this.persistDir !== undefined
        ? { persist: { dir: this.persistDir, cwd: input.cwd ?? this.cwd ?? "/" } }
        : {}),
    })
    const state: SessionState = {
      summary: {
        id,
        model,
        cwd: input.cwd ?? this.cwd ?? "/",
        mode: input.mode ?? "default",
        contextWindow: PLACEHOLDER_CONTEXT_WINDOW,
        createdAt: this.now(),
      },
      title: null,
      runs: 0,
      status: "idle",
      session,
    }
    this.sessions.set(id, state)
    return Promise.resolve(this.summarize(state))
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
