/**
 * The JSON the server sends, as the app reads it.
 *
 * The app does not import server or core code (AGENTS.md), so these types
 * restate the wire shapes of `server/src/api/routes.ts`,
 * `server/src/backend/history.ts`, and the session entry of spec 2.4. Event
 * kinds are additive: code that reads `SessionEntry.data` must accept kinds
 * and fields it does not know.
 *
 * @module api/types
 */

import type { UIMessage, UIMessageChunk } from "ai"

/** Which backend answers. Always `"core"`: the server runs a real `createRuntime`. */
export type BackendKind = "core"

/**
 * What `GET /api/sessions` says about the model transport: every session's
 * replies are scripted, not a real provider (see the web repo's AGENTS.md,
 * "Session backend", and `server/src/backend/runtime-backend.ts`).
 */
export interface TransportInfo {
  kind: "scripted"
  description: string
}

/** What a session is doing now. */
export type SessionStatus = "idle" | "running" | "waiting"

/** One session. */
export interface SessionSummary {
  id: string
  title: string
  model: string
  cwd: string
  mode: string
  contextWindow: number
  createdAt: number
  updatedAt: number
  status: SessionStatus
  runs: number
}

/** `GET /api/sessions`. */
export interface SessionList {
  backend: BackendKind
  transport: TransportInfo
  sessions: SessionSummary[]
}

/** Token usage of one completed turn. */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/** Payload of a `data-usage` part. */
export type UsageData =
  | { kind: "turn"; turn: number; usage: TurnUsage }
  | { kind: "quota"; provider: string; used?: number; limit?: number; resetAt?: number }

/**
 * Payload of a transient `data-status` part: core's known phases
 * (`sending`, `receiving`, `running_tool`, `retrying`, `waiting_for_quota`,
 * `waiting_for_host`), loosened to `string` so an added phase still decodes
 * (`chat/status-text.ts` falls back to showing the code itself).
 */
export interface StatusData {
  phase: string
  toolName?: string
  attempt?: number
  nextDelayMs?: number
  cause?: string
  resetAt?: number
}

/** One answer the person can pick for an ask (core's `AskUserOption`). */
export interface AskUserOption {
  id: string
  label: string
  description?: string
  isDefault?: boolean
  destructive?: boolean
}

/**
 * Payload of a `data-ask-user` part: core's preflight ask (spec v1 S17), a
 * multiple-choice question unrelated to any specific tool call (core has no
 * tool-approval concept). There is no corresponding "answered" event, so the
 * app marks one answered itself, right when it posts the answer.
 */
export interface AskUserData {
  askId: string
  code: string
  title: string
  detail: string
  options: AskUserOption[]
}

/** Payload of a `data-notice` part: core's notice. */
export interface NoticeData {
  kind: string
  severity?: string
  message?: string
  [key: string]: unknown
}

/** The data parts of the chat stream, keyed without the `data-` prefix. */
export type ChatDataTypes = {
  usage: UsageData
  notice: NoticeData
  status: StatusData
  "ask-user": AskUserData
}

/** A chat message as `useChat` holds it. */
export type ChatMessage = UIMessage<unknown, ChatDataTypes>

/** One part of a chat message. */
export type ChatPart = ChatMessage["parts"][number]

/** One message of `GET /api/sessions/:id` history. */
export type HistoryMessage =
  | { id: string; role: "user"; text: string }
  | {
      id: string
      role: "assistant"
      chunks: UIMessageChunk<unknown, ChatDataTypes>[]
      running: boolean
    }

/** `GET /api/sessions/:id`. */
export interface SessionDetail {
  backend: BackendKind
  transport: TransportInfo
  session: SessionSummary
  history: HistoryMessage[]
}

/** RFC 5424 severities, most severe first. */
export const SEVERITIES = [
  "emergency",
  "alert",
  "critical",
  "error",
  "warning",
  "notice",
  "info",
  "debug",
] as const

/** A severity name. Its index in {@link SEVERITIES} is the RFC 5424 number. */
export type SeverityName = (typeof SEVERITIES)[number]

/** One diagnostic (`ch: "diag"`). */
export interface DiagnosticData {
  severity: number
  facility: number
  code: string
  message: string
  data?: Record<string, string | number | boolean>
}

/** An agent event (`ch: "event"`). Only `type` is certain. */
export interface EventData {
  type: string
  [key: string]: unknown
}

/** One entry of the session event log (spec 2.4). */
export type SessionEntry =
  | { v: 1; seq: number; ts: number; sessionId: string; ch: "event"; data: EventData }
  | { v: 1; seq: number; ts: number; sessionId: string; ch: "diag"; data: DiagnosticData }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True for a well-formed entry. Unknown event kinds pass. */
export function isSessionEntry(value: unknown): value is SessionEntry {
  if (!isRecord(value) || value.v !== 1) return false
  if (typeof value.seq !== "number" || typeof value.ts !== "number") return false
  if (typeof value.sessionId !== "string" || !isRecord(value.data)) return false
  if (value.ch === "event") return typeof value.data.type === "string"
  if (value.ch === "diag") {
    return (
      typeof value.data.severity === "number" &&
      typeof value.data.code === "string" &&
      typeof value.data.message === "string"
    )
  }
  return false
}
