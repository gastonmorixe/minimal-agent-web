/**
 * The AI SDK UI message stream parts this server writes (spec 4.3, D24).
 *
 * The server does not depend on the AI SDK at runtime, so these types are a
 * local copy of the subset of `UIMessageChunk` (package `ai`, file
 * `ui-message-stream/ui-message-chunks.d.ts`) that the chat stream uses. Field
 * names match that file exactly. `chunks.test.ts` checks at compile time that
 * every chunk here is assignable to the AI SDK type.
 *
 * @module chat-stream/chunks
 */

import type {
  AskUserOption,
  EventUsage,
  NoticeEvent,
  StatusEvent,
} from "@minimal-agent/core/sdk/events"

/** Response headers of the UI message stream protocol (SSE, version 1). */
export const UI_MESSAGE_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-accel-buffering": "no",
} as const

/** Why the assistant message ended, as the `finish` part reports it. */
export type UiFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "interrupted"
  | "other"

/** Payload of a `data-usage` part: the token usage of one completed turn. */
export interface TurnUsageData {
  kind: "turn"
  /** The core turn index (`turn_completed.turn`). */
  turn: number
  usage: EventUsage
}

/** Payload of a quota `data-usage` part: core's `quota` event without its tag. */
export interface QuotaUsageData {
  kind: "quota"
  provider: string
  used?: number
  limit?: number
  /** Epoch ms. */
  resetAt?: number
}

/** Payload of a `data-usage` part. */
export type UsageData = TurnUsageData | QuotaUsageData

/** Payload of a `data-notice` part: core's notice, unchanged. */
export type NoticeData = NoticeEvent["notice"]

/** Payload of a transient `data-status` part: core's `status` event without its tag. */
export type StatusData = Omit<StatusEvent, "type">

/**
 * Payload of a `data-ask-user` part: core's preflight ask (spec v1 S17), a
 * multiple-choice question with no inherent connection to a tool call (see
 * `AskUserEvent`'s doc at `@minimal-agent/core/sdk/events`: it fires before a
 * send, for example when a conversation carries a thinking block signed by a
 * different model). `options` is unchanged from core; the chosen `answer` is
 * one of their `id`s, or `null` for a decline. There is no corresponding
 * "answered" event (core does not emit one — `session.answer` just resolves
 * the pending promise), so the client marks an ask answered itself, right
 * when it posts the answer.
 */
export interface AskUserData {
  askId: string
  code: string
  title: string
  detail: string
  options: AskUserOption[]
}

/**
 * The data part types of the chat stream, keyed by name without the `data-`
 * prefix. The frontend passes this to `UIMessage<unknown, ChatDataTypes>`.
 */
export type ChatDataTypes = {
  usage: UsageData
  notice: NoticeData
  status: StatusData
  "ask-user": AskUserData
}

/**
 * One UI message stream part. Every tool part sets `dynamic: true`: the
 * frontend has no static types for core's tools, so it renders them as
 * `dynamic-tool` parts. There is no tool-approval part: core's `ask_user`
 * (spec v1 S17) is a preflight question unrelated to any specific tool call,
 * never a request to approve one (core has no tool-approval concept at all;
 * a tool call simply runs once the model emits it — see `backend/runtime-backend.ts`'s
 * module doc on the "no tools" scope decision, which also means these tool
 * parts never fire with today's sessions).
 */
export type UiMessageChunk =
  | { type: "start"; messageId?: string }
  | { type: "start-step" }
  | { type: "finish-step" }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | {
      type: "tool-input-available"
      toolCallId: string
      toolName: string
      input: unknown
      dynamic: true
    }
  | {
      type: "tool-output-available"
      toolCallId: string
      output: unknown
      dynamic: true
      preliminary?: true
    }
  | { type: "tool-output-error"; toolCallId: string; errorText: string; dynamic: true }
  | { type: "data-usage"; data: TurnUsageData }
  | { type: "data-usage"; id: string; data: QuotaUsageData }
  | { type: "data-notice"; data: NoticeData }
  | { type: "data-status"; data: StatusData; transient: true }
  | { type: "data-ask-user"; id: string; data: AskUserData }
  | { type: "error"; errorText: string }
  | { type: "finish"; finishReason?: UiFinishReason }
