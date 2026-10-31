/**
 * Core event kinds the web host needs before core exports them.
 *
 * MIRROR, NOT OURS. Core at the pinned commit has the nine v1 `AgentEvent`
 * kinds. Core phase 3 adds `user_message`, `status`, `tool_call`,
 * `tool_output`, `quota`, `ask_user`, and `run_finished`, and adds facts to
 * `tool_result` (spec v2 2.4, spec v1 3.2, specs S17 to S19). The shapes here
 * follow the payloads those specs name. Everything else in them is a guess.
 *
 * When core exports these kinds (S47/S53), delete this file and import
 * `AgentEvent` from core. Typecheck then shows every place that must change.
 *
 * `ask_answered` is not in the spec text. Spec 2.3 has `session.answer` but no
 * event for it, and a frontend that replays the log needs to know an ask was
 * answered. The fake backend emits it. S53 must check that
 * core emits it (or an equivalent) and adjust here.
 *
 * @module core-mirror/events
 */

import type { AgentEvent, ToolResultEvent } from "@minimal-agent/core/sdk/events"

/** The input that started a run (S18). */
export interface UserMessageEvent {
  type: "user_message"
  text: string
}

/**
 * Status phase codes. The first group is today's core status bus
 * (`src/bus/status.ts`). The second group is the run policy of spec 2.2.
 * Codes only: the frontend owns the labels.
 */
export type StatusPhase =
  | "connect"
  | "upload"
  | "wait-headers"
  | "stream"
  | "thinking"
  | "writing"
  | "tool-input"
  | "tool-dispatch"
  | "tool-run"
  | "auth-refresh"
  | "error"
  | "aborted"
  | "done"
  | "retrying"
  | "waiting_for_quota"
  | "waiting_for_host"

/** What the loop is doing now (S23, spec 2.2). Transient: not part of the reply. */
export interface StatusEvent {
  type: "status"
  phase: StatusPhase
  toolName?: string
  /** `retrying`: the attempt that failed, from 1. Feeds backoff only. */
  attempt?: number
  /** `retrying`: how long the loop waits before the next attempt. */
  nextDelayMs?: number
  /** `retrying`: why the attempt failed, as a short code. */
  cause?: string
  /** `waiting_for_quota`: when the quota resets, epoch ms. */
  resetAt?: number
}

/** A tool call starts (S18, S19). */
export interface ToolCallEvent {
  type: "tool_call"
  /** The tool_use id, as in `item_completed` and `tool_result`. */
  callId: string
  toolName: string
  inputSummary: string
}

/** Tool output, emitted only when a sink asks for it. `text` is capped at 16 KiB per event. */
export interface ToolOutputEvent {
  type: "tool_output"
  callId: string
  toolName: string
  text: string
  truncated: boolean
  totalBytes: number
}

/** `tool_result` with the facts S19 adds. Additive: the v1 fields stay. */
export interface ToolResultFactsEvent extends ToolResultEvent {
  inputSummary?: string
  outputSummary?: string
  durationMs?: number
}

/** Provider quota (S28). */
export interface QuotaEvent {
  type: "quota"
  provider: string
  used?: number
  limit?: number
  /** Epoch ms. */
  resetAt?: number
}

/** The run asks the person something (S17). */
export interface AskUserEvent {
  type: "ask_user"
  askId: string
  /** `approval`: approve or deny the tool call `callId`. `question`: free-form. */
  kind: "approval" | "question"
  question: string
  /** The tool call to approve. Set when `kind` is `approval`. */
  callId?: string
  toolName?: string
  inputSummary?: string
  /** Suggested answers for a question. */
  options?: string[]
}

/** An answer to an `ask_user` (`POST /api/sessions/:id/answers`). */
export type AskAnswer =
  | { kind: "approval"; approved: boolean; reason?: string }
  | { kind: "text"; text: string }

/** An ask was answered. Proposed, not in the spec text (see the module doc). */
export interface AskAnsweredEvent {
  type: "ask_answered"
  askId: string
  answer: AskAnswer
}

/** How a run ended (spec 2.1). */
export type RunOutcome = "completed" | "truncated" | "failed" | "aborted" | "waiting"

/** The run ended. Each run ends with exactly one (S18). */
export interface RunFinishedEvent {
  type: "run_finished"
  outcome: RunOutcome
}

/** The kinds core phase 3 adds. */
export type PendingCoreEvent =
  | UserMessageEvent
  | StatusEvent
  | ToolCallEvent
  | ToolOutputEvent
  | QuotaEvent
  | AskUserEvent
  | AskAnsweredEvent
  | RunFinishedEvent

/** Every event the web host handles: core's kinds today, plus the pending ones. */
export type WebAgentEvent =
  | Exclude<AgentEvent, ToolResultEvent>
  | ToolResultFactsEvent
  | PendingCoreEvent
