/**
 * Golden runs for the chat stream adapter: core event sequences, in the order
 * today's `AgentCore.run` emits them.
 *
 * The order follows `src/sdk/agent-core.ts` in core: `turn_started`, then the
 * live deltas (only with `emitDeltas`), then one `item_started` /
 * `item_completed` pair per content block, then notices, then `tool_result`
 * per executed tool, then `turn_completed`. A continuation (`max_tokens`)
 * starts the next turn without a `turn_completed`. `error` is terminal.
 *
 * Each run's expected SSE output is `goldens/<name>.sse`.
 *
 * @module chat-stream/golden-runs
 */

import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import type { ChatStreamInput } from "./adapter.ts"

/** A named input sequence and the golden file that holds its SSE output. */
export interface GoldenRun {
  name: string
  inputs: ChatStreamInput[]
}

function run(messageId: string, events: AgentEvent[]): ChatStreamInput[] {
  return [
    { kind: "run_started", messageId },
    ...events.map((event): ChatStreamInput => ({ kind: "event", event })),
    { kind: "run_ended" },
  ]
}

/** A plain text turn, streamed with deltas. */
const TEXT_TURN: GoldenRun = {
  name: "text-turn",
  inputs: run("msg-text", [
    { type: "turn_started", turn: 1 },
    { type: "text_delta", id: "1:text", text: "Hello" },
    { type: "text_delta", id: "1:text", text: ", world." },
    { type: "item_started", itemType: "text", id: "1:0" },
    { type: "item_completed", itemType: "text", id: "1:0", text: "Hello, world." },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 4 },
    },
  ]),
}

/** A turn that thinks first, then answers. */
const REASONING_TURN: GoldenRun = {
  name: "reasoning-turn",
  inputs: run("msg-reasoning", [
    { type: "turn_started", turn: 1 },
    { type: "thinking_delta", id: "1:thinking", text: "The user wants" },
    { type: "thinking_delta", id: "1:thinking", text: " a short answer." },
    { type: "text_delta", id: "1:text", text: "Short answer." },
    { type: "item_started", itemType: "thinking", id: "1:0" },
    {
      type: "item_completed",
      itemType: "thinking",
      id: "1:0",
      text: "The user wants a short answer.",
    },
    { type: "item_started", itemType: "text", id: "1:1" },
    { type: "item_completed", itemType: "text", id: "1:1", text: "Short answer." },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 40, outputTokens: 18, cacheReadTokens: 32 },
    },
  ]),
}

/** A tool round, then the final answer. */
const TOOL_TURN: GoldenRun = {
  name: "tool-turn",
  inputs: run("msg-tool", [
    { type: "turn_started", turn: 1 },
    { type: "text_delta", id: "1:text", text: "Let me read it." },
    { type: "item_started", itemType: "text", id: "1:0" },
    { type: "item_completed", itemType: "text", id: "1:0", text: "Let me read it." },
    { type: "item_started", itemType: "tool_use", id: "toolu_01" },
    { type: "item_completed", itemType: "tool_use", id: "toolu_01", text: "Read" },
    { type: "tool_result", id: "toolu_01", name: "Read", isError: false },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "tool_use",
      usage: { inputTokens: 30, outputTokens: 9 },
    },
    { type: "turn_started", turn: 2 },
    { type: "text_delta", id: "2:text", text: "The file has three lines." },
    { type: "item_started", itemType: "text", id: "2:0" },
    { type: "item_completed", itemType: "text", id: "2:0", text: "The file has three lines." },
    {
      type: "turn_completed",
      turn: 2,
      stopReason: "end_turn",
      usage: { inputTokens: 52, outputTokens: 7 },
    },
  ]),
}

/** A provider error in the middle of a streamed reply. */
const ERROR_TURN: GoldenRun = {
  name: "error-turn",
  inputs: run("msg-error", [
    { type: "turn_started", turn: 1 },
    { type: "text_delta", id: "1:text", text: "Working on" },
    {
      type: "error",
      message: "The provider rejected the credential.",
      code: "auth_invalid",
      hint: "Log in again.",
    },
  ]),
}

/**
 * Buffered mode (no deltas) with a `max_tokens` continuation: turn 1 is cut
 * off, core emits a notice and starts turn 2 without a `turn_completed`.
 */
const BUFFERED_CONTINUATION: GoldenRun = {
  name: "buffered-continuation",
  inputs: run("msg-buffered", [
    { type: "turn_started", turn: 1 },
    { type: "item_started", itemType: "thinking", id: "1:0" },
    { type: "item_completed", itemType: "thinking", id: "1:0", text: "Plan the list." },
    { type: "item_started", itemType: "text", id: "1:1" },
    { type: "item_completed", itemType: "text", id: "1:1", text: "1. Install" },
    {
      type: "notice",
      notice: { kind: "max_tokens_continuing", severity: "warn", attempt: 1, cap: 5 },
    },
    { type: "turn_started", turn: 2 },
    { type: "item_started", itemType: "text", id: "2:0" },
    { type: "item_completed", itemType: "text", id: "2:0", text: "\n2. Run" },
    {
      type: "turn_completed",
      turn: 2,
      stopReason: "end_turn",
      usage: { inputTokens: 70, outputTokens: 5 },
    },
  ]),
}

/** Every golden run. */
export const GOLDEN_RUNS: readonly GoldenRun[] = [
  TEXT_TURN,
  REASONING_TURN,
  TOOL_TURN,
  ERROR_TURN,
  BUFFERED_CONTINUATION,
]
