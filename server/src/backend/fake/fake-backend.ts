/**
 * The fake session backend: in memory, deterministic, no model.
 *
 * FOR DEVELOPMENT AND TESTS ONLY. It implements {@link SessionBackend} by
 * replaying canned runs (`scenarios.ts`) into a per-session event log. It
 * never talks to a provider, reads no credentials, and touches no files. The
 * API reports `backend: "fake"`, and the app shows a banner that says so.
 * S53 adds the core-backed backend and makes it the default.
 *
 * Determinism: ids come from per-backend and per-session counters, `ts` from
 * the injected clock, and a message always picks the same scenario. Only the
 * timing between steps (`stepDelayMs`) is real time.
 *
 * @module backend/fake/fake-backend
 */

import type { AskAnswer, AskUserEvent, WebAgentEvent } from "../../core-mirror/events.ts"
import {
  type SessionEntryListener,
  Severity,
  type Unsubscribe,
} from "../../core-mirror/session-entry.ts"
import { AsyncQueue } from "../async-queue.ts"
import {
  BackendError,
  type CreateSessionInput,
  type SessionBackend,
  type SessionSummary,
  type SubscribeOptions,
  type TurnHandle,
} from "../backend.ts"
import { assistantMessageId } from "../history.ts"

import { EntryLog } from "./entry-log.ts"
import { pickScenario, type Step } from "./scenarios.ts"

/** Options for {@link FakeBackend}. */
export interface FakeBackendOptions {
  /** Real time between two steps of a run. Default 25 ms. */
  stepDelayMs?: number
  /** Clock for entry `ts` and `createdAt`, epoch ms. Default `Date.now`. */
  now?: () => number
}

/** The fake model's context window, for the Context element. */
export const FAKE_CONTEXT_WINDOW = 200_000

const DEFAULT_STEP_DELAY_MS = 25
const TITLE_LENGTH = 60

interface PendingAsk {
  ask: AskUserEvent
  resolve: (answer: AskAnswer) => void
}

interface ActiveRun {
  controller: AbortController
  pendingAsk: PendingAsk | null
}

interface FakeSession {
  summary: Omit<SessionSummary, "status" | "updatedAt" | "title" | "runs">
  title: string | null
  runs: number
  log: EntryLog
  active: ActiveRun | null
  calls: number
  asks: number
}

/** Resolves after `ms`, or rejects at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function answerFits(ask: AskUserEvent, answer: AskAnswer): boolean {
  return ask.kind === "approval" ? answer.kind === "approval" : answer.kind === "text"
}

/** The fake backend. See the module doc. */
export class FakeBackend implements SessionBackend {
  readonly kind = "fake"
  private readonly sessions = new Map<string, FakeSession>()
  private readonly stepDelayMs: number
  private readonly now: () => number
  private created = 0

  /** Create the backend. It starts with no sessions. */
  constructor(options: FakeBackendOptions = {}) {
    this.stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS
    this.now = options.now ?? Date.now
  }

  /** Create a session. */
  createSession(input: CreateSessionInput): Promise<SessionSummary> {
    this.created++
    const id = `fake-${this.created}`
    const session: FakeSession = {
      summary: {
        id,
        model: input.model ?? "fake-model",
        cwd: input.cwd ?? "/fake/workspace",
        mode: input.mode ?? "default",
        contextWindow: FAKE_CONTEXT_WINDOW,
        createdAt: this.now(),
      },
      title: null,
      runs: 0,
      log: new EntryLog(id, this.now),
      active: null,
      calls: 0,
      asks: 0,
    }
    this.sessions.set(id, session)
    return Promise.resolve(this.summarize(session))
  }

  /** Every session, newest first. */
  listSessions(): Promise<SessionSummary[]> {
    const list = [...this.sessions.values()].map((session) => this.summarize(session))
    return Promise.resolve(list.reverse())
  }

  /** One session, or `undefined`. */
  getSession(id: string): Promise<SessionSummary | undefined> {
    const session = this.sessions.get(id)
    return Promise.resolve(session === undefined ? undefined : this.summarize(session))
  }

  /** Start a canned run picked by the message text. */
  startTurn(id: string, input: { text: string }): Promise<TurnHandle> {
    const session = this.require(id)
    if (session.active !== null) {
      return Promise.reject(new BackendError("busy", `session ${id} is running a turn`))
    }
    session.title ??= input.text.trim().slice(0, TITLE_LENGTH) || "Untitled"
    session.runs++
    const active: ActiveRun = { controller: new AbortController(), pendingAsk: null }
    session.active = active
    const userEntry = session.log.appendEvent({ type: "user_message", text: input.text })

    let unsubscribe: Unsubscribe = () => {}
    const queue = new AsyncQueue<WebAgentEvent>(() => unsubscribe())
    unsubscribe = session.log.subscribe((entry) => {
      if (entry.ch !== "event") return
      queue.push(entry.data)
      if (entry.data.type === "run_finished") queue.end()
    }, userEntry.seq)

    const scenario = pickScenario(input.text)
    const steps = scenario.steps({
      text: input.text,
      callId: () => `call_${++session.calls}`,
      askId: () => `ask_${++session.asks}`,
      now: this.now(),
    })
    session.log.appendDiag({
      severity: Severity.Info,
      facility: 1,
      code: "fake.scenario",
      message: `fake backend plays the "${scenario.name}" scenario`,
    })
    void this.play(session, active, steps)
    return Promise.resolve({ messageId: assistantMessageId(userEntry.seq), events: queue })
  }

  /** Subscribe to a session's log. */
  subscribe(
    id: string,
    listener: SessionEntryListener,
    options: SubscribeOptions = {},
  ): Unsubscribe {
    return this.require(id).log.subscribe(listener, options.fromSeq)
  }

  /** Answer the pending ask. */
  answer(id: string, askId: string, answer: AskAnswer): void {
    const pending = this.require(id).active?.pendingAsk
    if (pending === undefined || pending === null || pending.ask.askId !== askId) {
      throw new BackendError("no_such_ask", `no pending ask ${askId} in session ${id}`)
    }
    if (!answerFits(pending.ask, answer)) {
      throw new BackendError("invalid", `ask ${askId} needs a ${pending.ask.kind} answer`)
    }
    pending.resolve(answer)
  }

  /** Abort the current run. */
  abort(id: string, reason?: string): boolean {
    const active = this.require(id).active
    if (active === null) return false
    active.controller.abort(reason ?? "aborted")
    return true
  }

  /** Abort every run. */
  close(): void {
    for (const session of this.sessions.values()) session.active?.controller.abort("closed")
  }

  private require(id: string): FakeSession {
    const session = this.sessions.get(id)
    if (session === undefined) throw new BackendError("not_found", `no session ${id}`)
    return session
  }

  private summarize(session: FakeSession): SessionSummary {
    const { active } = session
    return {
      ...session.summary,
      title: session.title ?? "New session",
      updatedAt: session.log.lastTs ?? session.summary.createdAt,
      status: active === null ? "idle" : active.pendingAsk === null ? "running" : "waiting",
      runs: session.runs,
    }
  }

  /** Play a run to its end, or to the abort. */
  private async play(session: FakeSession, active: ActiveRun, steps: Step[]): Promise<void> {
    const { signal } = active.controller
    try {
      await this.playSteps(session, active, steps)
    } catch (error) {
      // Spec 2.1, stop-table row 1: an aborted run emits `error` "aborted",
      // then `run_finished`. Anything else is a bug in a scenario.
      const aborted = signal.aborted
      const message = aborted ? `run aborted: ${String(signal.reason)}` : String(error)
      session.log.appendDiag({
        severity: aborted ? Severity.Notice : Severity.Error,
        facility: 1,
        code: aborted ? "run.aborted" : "fake.scenario-error",
        message,
      })
      session.log.appendEvent({
        type: "error",
        message: aborted ? "aborted" : message,
        code: aborted ? "aborted" : "internal",
      })
      session.active = null
      session.log.appendEvent({ type: "run_finished", outcome: aborted ? "aborted" : "failed" })
    }
  }

  private async playSteps(session: FakeSession, active: ActiveRun, steps: Step[]): Promise<void> {
    const { signal } = active.controller
    for (const step of steps) {
      await sleep(this.stepDelayMs, signal)
      switch (step.kind) {
        case "event":
          // Free the session before its last entry, so a client that reacts
          // to `run_finished` can start the next turn at once.
          if (step.event.type === "run_finished") session.active = null
          session.log.appendEvent(step.event)
          break
        case "diag":
          session.log.appendDiag(step.diag)
          break
        case "pause":
          await sleep(step.ms, signal)
          break
        case "ask": {
          const answer = await this.waitForAnswer(session, active, step.ask)
          session.log.appendEvent({ type: "ask_answered", askId: step.ask.askId, answer })
          await this.playSteps(session, active, step.next(answer))
          break
        }
        default:
          unreachable(step)
      }
    }
  }

  private waitForAnswer(
    session: FakeSession,
    active: ActiveRun,
    ask: AskUserEvent,
  ): Promise<AskAnswer> {
    const { signal } = active.controller
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        active.pendingAsk = null
        reject(signal.reason)
      }
      active.pendingAsk = {
        ask,
        resolve: (answer) => {
          active.pendingAsk = null
          signal.removeEventListener("abort", onAbort)
          resolve(answer)
        },
      }
      signal.addEventListener("abort", onAbort, { once: true })
      session.log.appendEvent(ask)
    })
  }
}

function unreachable(_value: never): void {}
