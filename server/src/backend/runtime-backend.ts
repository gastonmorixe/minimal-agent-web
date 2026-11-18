/**
 * The real, core-backed session backend (spec v2 section 2.3, S53).
 *
 * `RuntimeBackend` implements {@link SessionBackend} on one `createRuntime`
 * instance (core S47/S48): `createSession` → `runtime.openSession`,
 * `startTurn` → `session.run`, `subscribe` → `session.subscribe`, `answer` →
 * `session.answer`, `abort` → `session.abort`, `setTarget` →
 * `AgentCore.switchTarget` of that one session. It replaces the S52
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
 * - real credentials from `host.resolveAuth(model, providerId, credentialName)`,
 *   with the provider of the model row, so a model id that two providers
 *   register gets the auth of the right one,
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
 * The web never resumes a session: `createSession` always opens a new
 * session, and a restart drops all in-memory sessions.
 *
 * ## The target of a session
 *
 * A session starts on the credential, provider, model and effort of its
 * `createSession` call. `setTarget` changes them at any time, also while a
 * turn runs or waits for a retry or a quota reset (`backend/target.ts` has
 * the checks). The summary reads the live values from the session's core.
 *
 * One server process has many sessions and one plugin loader. So a target
 * change touches only the `AgentCore` of its session. It writes no
 * `process.env` value and sets no field of the loader: both are for the
 * process, and an other session would read them. The tool executor of the
 * session follows the model through the core's own target-change event
 * (`backend/live-tool-executor.ts`).
 *
 * Not done: a sub-agent that a web session starts does not get the target
 * of that session. The sub-agents plugin reads the target of the process
 * (the env and the loader), which the web host does not set. This gap is
 * older than `setTarget`.
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
import type { BootedHost } from "@minimal-agent/core/host-kit/host-boot"
import { createLifecyclePort } from "@minimal-agent/core/host-kit/lifecycle-port-adapter"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { authErrorText } from "./auth-error-text.ts"
import {
  BackendError,
  type CreateSessionInput,
  type CredentialInfo,
  type ModelList,
  type SessionBackend,
  type SessionStatus,
  type SessionSummary,
  type SetTargetInput,
  type TransportInfo,
  type TurnHandle,
} from "./backend.ts"
import { assistantMessageId } from "./history.ts"
import { LiveToolExecutor } from "./live-tool-executor.ts"
import { checkEffort, credentialNamesOf, findRow, targetSelection } from "./target.ts"
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
  /** Provider mode: the tool executor of the session, which follows its live model. */
  tools?: LiveToolExecutor
}

const TITLE_LENGTH = 60

/**
 * Time in ms that a preflight `ask_user` waits for `POST .../answers`. Then
 * core resolves it with its default option, or declines it. Decision 11: no
 * human is assumed, so an ask never waits forever.
 */
export const ASK_DEADLINE_MS = 5 * 60_000

interface SessionState {
  /** The fixed part of the summary. The live target comes from the core. */
  summary: Pick<SessionSummary, "id" | "cwd" | "mode" | "contextWindow" | "createdAt">
  title: string | null
  runs: number
  status: SessionStatus
  session: Session
  /** The target changes of this session run one after the other. */
  targetQueue: Promise<unknown>
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

/** What {@link RuntimeBackend.transport} says in provider mode. `providerId` is compat only: the server picks no default and the UI must not display it as a default pick. */
function providerTransport(host: BootedHost): TransportInfo {
  const entries = host.listCredentials()
  const usableCount = entries.filter((entry) => entry.credentialInfo?.usable ?? true).length
  const providerId =
    entries.find((entry) => entry.credentialInfo?.usable ?? true)?.providerId ??
    entries[0]?.providerId ??
    host.models[0]?.providerId ??
    host.providers[0] ??
    "unknown"
  return {
    kind: "provider",
    providerId,
    description: `${usableCount} credentials ready: pick a credential and model per session.`,
  }
}

/**
 * Provider mode: real auth, host tools, no `sendFn`, and the row's context
 * window. `providerId` scopes the row lookup. `credentialName` selects one
 * stored credential of the provider. `effort` must be a level of the model:
 * it is checked here, and the caller sets it on the core after the open.
 */
export async function providerParts(
  host: BootedHost,
  modelId: string,
  providerId?: string,
  credentialName?: string,
  effort?: string,
): Promise<ModeSessionParts> {
  if (credentialName !== undefined && providerId === undefined) {
    throw new BackendError(
      "credential_needs_provider",
      `credentialName "${credentialName}" requires providerId: pick a provider for the credential`,
    )
  }
  if (credentialName !== undefined && providerId !== undefined) {
    const known = new Set(
      host
        .listCredentials()
        .filter((entry) => entry.providerId === providerId)
        .map((entry) => entry.credentialName),
    )
    if (!known.has(credentialName)) {
      throw new BackendError(
        "unknown_credential",
        `unknown credential "${credentialName}" for provider "${providerId}": no stored credential with that name`,
      )
    }
  }
  const row = findRow(host, modelId, providerId)
  if (row === undefined) {
    throw new BackendError("unknown_model", `no booted provider registers model "${modelId}"`)
  }
  if (effort !== undefined) checkEffort(row, effort)
  let auth: Awaited<ReturnType<BootedHost["resolveAuth"]>>
  try {
    auth = await host.resolveAuth(row.id, row.providerId, credentialName)
  } catch (error) {
    // Core throws a typed error with no text. The web text names the provider
    // and the login command. It holds no secret.
    throw new BackendError("auth_unavailable", authErrorText(error))
  }
  // One executor per session: it carries the model context of this session,
  // and it follows the model after a target change.
  const tools = new LiveToolExecutor(host, row.id)
  return {
    model: row.id,
    contextWindow: row.contextWindow,
    tools,
    open: {
      model: row.id,
      providerId: row.providerId,
      ...(credentialName !== undefined ? { credentialName } : {}),
      // The core checks a credential name of a target change against the store too.
      credentialNames: (provider) => credentialNamesOf(host, provider),
      auth,
      toolRegistry: host.toolRegistry,
      toolExecutor: tools,
      lifecycle: createLifecyclePort(host.loader.hooks()),
      // B1: the runtime has no loader, so pass the loader's text providers.
      syntheticTextProviders: host.loader.syntheticTextProviders(),
      toolTextProviders: host.loader.toolTextProviders(),
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

  /** What {@link SessionBackend.models} returns: model rows plus stored credentials. */
  credentials(): CredentialInfo[] {
    if (this.host === undefined) return []
    return this.host.listCredentials().map((entry) => ({
      providerId: entry.providerId,
      displayName: entry.displayName,
      authKind: entry.authKind,
      credentialName: entry.credentialName ?? entry.credentialLabel ?? entry.displayName,
      credentialLabel: entry.credentialLabel ?? entry.credentialName ?? entry.displayName,
      usable: entry.credentialInfo?.usable ?? true,
    }))
  }

  /** The models a session can use. Scripted mode has no model rows. */
  models(): ModelList {
    if (this.host === undefined)
      return { models: [], defaultModelId: SCRIPTED_MODEL, credentials: [] }
    return {
      models: [...this.host.models],
      defaultModelId: this.host.defaultModelId,
      credentials: this.credentials(),
    }
  }

  /**
   * Create a session. Provider mode requires an explicit model: no default
   * pick.
   *
   * @throws BackendError `cwd_mismatch` when `input.cwd` resolves to a
   *   directory other than the server cwd; `unknown_model` when `input.model`
   *   is missing or unregistered
   */
  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    if (input.cwd !== undefined && resolve(this.cwd, input.cwd) !== this.cwd) {
      throw new BackendError(
        "cwd_mismatch",
        `cwd must be the server cwd (${this.cwd}): tools run there, not in ${input.cwd}`,
      )
    }
    if (this.host !== undefined && input.model === undefined) {
      throw new BackendError(
        "unknown_model",
        "model is required: pick a credential and model per session",
      )
    }
    const parts =
      this.host === undefined
        ? this.scriptedParts(input)
        : await providerParts(
            this.host,
            input.model ?? "",
            input.providerId,
            input.credentialName,
            input.effort,
          )
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
    const core = session.agentCore()
    // The open takes four fixed effort names. `providerParts` checked the level
    // against the model, so set it here: a model can have other level names.
    if (input.effort !== undefined && this.host !== undefined) core.setEffort(input.effort)
    // The tools of THIS session follow the model of THIS session.
    const { tools } = parts
    if (tools !== undefined) {
      core.onTargetChange(({ to }) => {
        tools.model = to.model
      })
    }
    const state: SessionState = {
      summary: {
        id,
        cwd: this.cwd,
        mode: input.mode ?? "default",
        contextWindow: parts.contextWindow,
        createdAt: this.now(),
      },
      title: null,
      runs: 0,
      status: "idle",
      session,
      targetQueue: Promise.resolve(),
    }
    this.sessions.set(id, state)
    return this.summarize(state)
  }

  /**
   * Change the target of one session. See {@link SessionBackend.setTarget}
   * and `backend/target.ts`. Two changes of one session run one after the
   * other, so each one checks and resolves its auth against the target that
   * the change before it left.
   */
  setTarget(id: string, input: SetTargetInput): Promise<SessionSummary> {
    const state = this.sessions.get(id)
    if (state === undefined) {
      return Promise.reject(new BackendError("not_found", `no session ${id}`))
    }
    const result = state.targetQueue.then(() => this.applyTarget(state, input))
    state.targetQueue = result.catch(() => undefined)
    return result
  }

  private async applyTarget(state: SessionState, input: SetTargetInput): Promise<SessionSummary> {
    const { host } = this
    if (host === undefined) {
      throw new BackendError(
        "bad_target",
        "scripted mode has one scripted transport: a session has no target to change",
      )
    }
    const core = state.session.agentCore()
    const selection = await targetSelection(host, core.getTarget(), input)
    try {
      // With a turn in progress, the core adds one notice with the two targets
      // to that turn. With no turn, a notice would be an event outside a run
      // (the history would show a run that never ends), so the switch is quiet:
      // the summary that this call returns has the new target.
      if (selection !== null) core.switchTarget(selection, { quiet: state.status === "idle" })
      if (input.effort === null) core.setEffort(undefined)
    } catch (error) {
      // The core refused it (for example an output schema that the model cannot use).
      throw new BackendError("bad_target", error instanceof Error ? error.message : String(error))
    }
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
    // The live target of this session's own core: a target change shows at once.
    const target = state.session.agentCore().getTarget()
    const row =
      this.host === undefined ? undefined : findRow(this.host, target.model, target.providerId)
    return {
      ...state.summary,
      model: target.model,
      ...(target.providerId !== undefined ? { providerId: target.providerId } : {}),
      ...(target.credentialName !== undefined ? { credentialName: target.credentialName } : {}),
      ...(target.effort !== undefined ? { effort: target.effort } : {}),
      contextWindow: row?.contextWindow ?? state.summary.contextWindow,
      title: state.title ?? "New session",
      updatedAt: wholeLogOf(state.session).at(-1)?.ts ?? state.summary.createdAt,
      status: state.status,
      runs: state.runs,
    }
  }
}
