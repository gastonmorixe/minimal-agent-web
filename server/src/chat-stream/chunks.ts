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

import type { EventUsage, NoticeEvent } from "@minimal-agent/core/sdk/events"

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

/** Payload of a `data-notice` part: core's notice, unchanged. */
export type NoticeData = NoticeEvent["notice"]

/**
 * The data part types of the chat stream, keyed by name without the `data-`
 * prefix. The frontend passes this to `UIMessage<unknown, ChatDataTypes>`.
 */
export type ChatDataTypes = {
  usage: TurnUsageData
  notice: NoticeData
}

/**
 * One UI message stream part. Every tool part sets `dynamic: true`: the
 * frontend has no static types for core's tools, so it renders them as
 * `dynamic-tool` parts.
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
  | { type: "tool-output-available"; toolCallId: string; output: unknown; dynamic: true }
  | { type: "data-usage"; data: TurnUsageData }
  | { type: "data-notice"; data: NoticeData }
  | { type: "error"; errorText: string }
  | { type: "finish"; finishReason?: UiFinishReason }
