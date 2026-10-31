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
 * The runs from APPROVAL_TURN on use the kinds core phase 3 adds, from the
 * mirror in `core-mirror/events.ts`. Their order is a guess until core
 * emits them: `tool_call`, `tool_output`, and `tool_result` per executed
 * tool, the approval ask between the `tool_use` item and the `tool_call`,
 * and `run_finished` last.
 *
 * @module chat-stream/golden-runs
 */

import type { WebAgentEvent } from "../core-mirror/events.ts"

import type { ChatStreamInput } from "./adapter.ts"

/** A named input sequence and the golden file that holds its SSE output. */
export interface GoldenRun {
  name: string
  inputs: ChatStreamInput[]
}

function run(messageId: string, events: WebAgentEvent[]): ChatStreamInput[] {
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

/** A tool that needs approval: approved, run with streamed output, then the answer. */
const APPROVAL_TURN: GoldenRun = {
  name: "approval-turn",
  inputs: run("msg-approval", [
    { type: "user_message", text: "Clean up the build folder." },
    { type: "turn_started", turn: 1 },
    { type: "item_started", itemType: "tool_use", id: "toolu_02" },
    { type: "item_completed", itemType: "tool_use", id: "toolu_02", text: "Bash" },
    {
      type: "ask_user",
      askId: "ask_1",
      kind: "approval",
      question: "Run rm -rf dist?",
      callId: "toolu_02",
      toolName: "Bash",
      inputSummary: "rm -rf dist",
    },
    { type: "ask_answered", askId: "ask_1", answer: { kind: "approval", approved: true } },
    { type: "tool_call", callId: "toolu_02", toolName: "Bash", inputSummary: "rm -rf dist" },
    {
      type: "tool_output",
      callId: "toolu_02",
      toolName: "Bash",
      text: "removed dist/a.js\n",
      truncated: false,
      totalBytes: 18,
    },
    {
      type: "tool_output",
      callId: "toolu_02",
      toolName: "Bash",
      text: "removed dist/b.js\n",
      truncated: false,
      totalBytes: 36,
    },
    {
      type: "tool_result",
      id: "toolu_02",
      name: "Bash",
      isError: false,
      inputSummary: "rm -rf dist",
      outputSummary: "2 files removed",
      durationMs: 120,
    },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "tool_use",
      usage: { inputTokens: 80, outputTokens: 12 },
    },
    { type: "turn_started", turn: 2 },
    { type: "item_started", itemType: "text", id: "2:0" },
    { type: "item_completed", itemType: "text", id: "2:0", text: "Removed the dist folder." },
    {
      type: "turn_completed",
      turn: 2,
      stopReason: "end_turn",
      usage: { inputTokens: 101, outputTokens: 6 },
    },
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** A tool the person denies. Core reports the call as an error result. */
const DENIED_TURN: GoldenRun = {
  name: "denied-turn",
  inputs: run("msg-denied", [
    { type: "turn_started", turn: 1 },
    { type: "item_completed", itemType: "tool_use", id: "toolu_03", text: "Bash" },
    {
      type: "ask_user",
      askId: "ask_2",
      kind: "approval",
      question: "Run rm -rf dist?",
      callId: "toolu_03",
      toolName: "Bash",
      inputSummary: "rm -rf dist",
    },
    {
      type: "ask_answered",
      askId: "ask_2",
      answer: { kind: "approval", approved: false, reason: "Keep it." },
    },
    { type: "tool_result", id: "toolu_03", name: "Bash", isError: true, outputSummary: "denied" },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "tool_use",
      usage: { inputTokens: 60, outputTokens: 10 },
    },
    { type: "turn_started", turn: 2 },
    { type: "item_completed", itemType: "text", id: "2:0", text: "I left dist in place." },
    {
      type: "turn_completed",
      turn: 2,
      stopReason: "end_turn",
      usage: { inputTokens: 75, outputTokens: 6 },
    },
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** A free-form question, its answer, and the reply that uses it. */
const QUESTION_TURN: GoldenRun = {
  name: "question-turn",
  inputs: run("msg-question", [
    { type: "turn_started", turn: 1 },
    {
      type: "ask_user",
      askId: "ask_3",
      kind: "question",
      question: "Which branch?",
      options: ["main", "dev"],
    },
    { type: "ask_answered", askId: "ask_3", answer: { kind: "text", text: "dev" } },
    { type: "item_completed", itemType: "text", id: "1:0", text: "Using dev." },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 30, outputTokens: 3 },
    },
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** Retries and a quota wait before the reply. Status parts are transient. */
const RETRY_TURN: GoldenRun = {
  name: "retry-turn",
  inputs: run("msg-retry", [
    { type: "turn_started", turn: 1 },
    { type: "status", phase: "retrying", attempt: 1, nextDelayMs: 1000, cause: "overloaded" },
    { type: "status", phase: "retrying", attempt: 2, nextDelayMs: 2000, cause: "overloaded" },
    { type: "quota", provider: "fake", used: 100, limit: 100, resetAt: 1_700_000_060_000 },
    { type: "status", phase: "waiting_for_quota", resetAt: 1_700_000_060_000 },
    { type: "status", phase: "stream" },
    { type: "item_completed", itemType: "text", id: "1:0", text: "Done after the wait." },
    {
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 5 },
    },
    { type: "run_finished", outcome: "completed" },
  ]),
}

/** Every golden run. */
export const GOLDEN_RUNS: readonly GoldenRun[] = [
  TEXT_TURN,
  REASONING_TURN,
  TOOL_TURN,
  ERROR_TURN,
  BUFFERED_CONTINUATION,
  APPROVAL_TURN,
  DENIED_TURN,
  QUESTION_TURN,
  RETRY_TURN,
]
