/**
 * Golden runs for the chat stream adapter: core event sequences, in the order
 * `AgentCore.run` emits them.
 *
 * The order follows `src/sdk/agent-core.ts` in core: `turn_started`, then the
 * live deltas (only with `emitDeltas`), then one `item_started` /
 * `item_completed` pair per content block, then notices, then any
 * `tool_call` / `tool_output` / `tool_result` per executed tool, then
 * `turn_completed`. A continuation (`max_tokens`) starts the next turn
 * without a `turn_completed`. `error` is terminal unless it is recoverable
 * (`status` phase `waiting_for_host`, then `run_finished` with outcome
 * `"waiting"` — the run is paused, not over). `run_finished` always ends a
 * run.
 *
 * Shapes are core's real, exported `AgentEvent` (`@minimal-agent/core/sdk/events`).
 * `TOOL_TURN` and `ASK_TURN` are still synthetic — today's sessions
 * (`backend/runtime-backend.ts`) run with no `toolRegistry` and so never
 * produce `tool_call` / `item_completed` tool_use / `tool_result`, and no
 * scripted transport scenario triggers a real `ask_user` (see that file's
 * "no tools" scope note). They exist to keep the adapter's mapping for
 * those kinds under test regardless.
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
    { type: "user_message", text: "Say hello." },
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
    { type: "run_finished", outcome: "completed" },
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
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** A tool round, then the final answer. Synthetic — see the module doc. */
const TOOL_TURN: GoldenRun = {
  name: "tool-turn",
  inputs: run("msg-tool", [
    { type: "turn_started", turn: 1 },
    { type: "text_delta", id: "1:text", text: "Let me read it." },
    { type: "item_started", itemType: "text", id: "1:0" },
    { type: "item_completed", itemType: "text", id: "1:0", text: "Let me read it." },
    { type: "item_started", itemType: "tool_use", id: "toolu_01", toolName: "Read" },
    { type: "item_completed", itemType: "tool_use", id: "toolu_01", text: "Read" },
    {
      type: "tool_call",
      callId: "toolu_01",
      toolName: "Read",
      input: { path: "README.md" },
      inputSummary: "README.md",
    },
    {
      type: "tool_output",
      callId: "toolu_01",
      toolName: "Read",
      text: "# demo\n",
      truncated: false,
      totalBytes: 7,
    },
    {
      type: "tool_result",
      id: "toolu_01",
      name: "Read",
      isError: false,
      inputSummary: "README.md",
      outputSummary: "3 lines",
      durationMs: 12,
    },
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
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** A failed tool call. Synthetic — see the module doc. */
const TOOL_ERROR_TURN: GoldenRun = {
  name: "tool-error-turn",
  inputs: run("msg-tool-error", [
    { type: "turn_started", turn: 1 },
    { type: "item_completed", itemType: "tool_use", id: "toolu_02", text: "Bash" },
    {
      type: "tool_call",
      callId: "toolu_02",
      toolName: "Bash",
      input: { command: "false" },
      inputSummary: "false",
    },
    {
      type: "tool_result",
      id: "toolu_02",
      name: "Bash",
      isError: true,
      outputSummary: "exit code 1",
    },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 5 },
    },
    { type: "turn_started", turn: 2 },
    { type: "item_completed", itemType: "text", id: "2:0", text: "That command failed." },
    {
      type: "turn_completed",
      turn: 2,
      stopReason: "end_turn",
      usage: { inputTokens: 35, outputTokens: 4 },
    },
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** A preflight ask (spec v1 S17). Synthetic — see the module doc. */
const ASK_TURN: GoldenRun = {
  name: "ask-turn",
  inputs: run("msg-ask", [
    { type: "turn_started", turn: 1 },
    {
      type: "ask_user",
      askId: "ask_1",
      code: "signed_thinking_mismatch",
      title: "Thinking signed by another model",
      detail: "The last turn's reasoning was signed by a different model.\nKeep it or drop it?",
      options: [
        { id: "keep", label: "Keep it", isDefault: true },
        { id: "drop", label: "Drop it", destructive: true },
      ],
    },
    { type: "item_completed", itemType: "text", id: "1:0", text: "Kept the reasoning." },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 18, outputTokens: 3 },
    },
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** A fatal provider error in the middle of a streamed reply. Terminal: the run fails. */
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
      recoverable: false,
    },
    { type: "status", phase: "waiting_for_host", cause: "permanent" },
    { type: "run_finished", outcome: "waiting" },
  ]),
}

/** Two retries, then the reply. `status` parts are transient. */
const RETRY_TURN: GoldenRun = {
  name: "retry-turn",
  inputs: run("msg-retry", [
    { type: "turn_started", turn: 1 },
    { type: "status", phase: "sending" },
    { type: "status", phase: "retrying", attempt: 1, nextDelayMs: 5, cause: "transient" },
    { type: "status", phase: "retrying", attempt: 2, nextDelayMs: 8, cause: "transient" },
    { type: "status", phase: "receiving" },
    { type: "item_completed", itemType: "text", id: "1:0", text: "Done after two retries." },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 5 },
    },
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** A quota wait, then the reply. */
const QUOTA_TURN: GoldenRun = {
  name: "quota-turn",
  inputs: run("msg-quota", [
    { type: "turn_started", turn: 1 },
    { type: "quota", provider: "scripted", used: 100, limit: 100, resetAt: 1_700_000_060_000 },
    {
      type: "status",
      phase: "waiting_for_quota",
      resetAt: 1_700_000_060_000,
      cause: "recoverable",
    },
    { type: "item_completed", itemType: "text", id: "1:0", text: "Done after the quota wait." },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 15, outputTokens: 5 },
    },
    { type: "run_finished", outcome: "completed" },
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
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** Every golden run. */
export const GOLDEN_RUNS: readonly GoldenRun[] = [
  TEXT_TURN,
  REASONING_TURN,
  TOOL_TURN,
  TOOL_ERROR_TURN,
  ASK_TURN,
  ERROR_TURN,
  RETRY_TURN,
  QUOTA_TURN,
  BUFFERED_CONTINUATION,
]
