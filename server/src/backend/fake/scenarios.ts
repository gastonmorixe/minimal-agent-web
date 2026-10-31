/**
 * Canned runs for the fake backend.
 *
 * Each scenario is a fixed list of steps: core events and diagnostics in the
 * order core emits them (see `chat-stream/golden-runs.ts`), plus asks that
 * wait for an answer. The person's message picks the scenario by keyword
 * ({@link pickScenario}), so a given message always replays the same run.
 * Nothing here calls a model: every reply says it comes from the fake.
 *
 * @module backend/fake/scenarios
 */

import type { EventUsage } from "@minimal-agent/core/sdk/events"

import type { AskAnswer, AskUserEvent, WebAgentEvent } from "../../core-mirror/events.ts"
import { type DiagnosticEvent, Severity } from "../../core-mirror/session-entry.ts"

/** One step of a canned run. */
export type Step =
  | { kind: "event"; event: WebAgentEvent }
  | { kind: "diag"; diag: DiagnosticEvent }
  /** Wait `ms` on top of the usual step delay. */
  | { kind: "pause"; ms: number }
  /** Emit the ask, wait for the answer, then play `next(answer)`. */
  | { kind: "ask"; ask: AskUserEvent; next: (answer: AskAnswer) => Step[] }

/** Deterministic ids for one run. */
export interface ScenarioContext {
  /** The person's message. */
  text: string
  /** The next tool call id of this session. */
  callId: () => string
  /** The next ask id of this session. */
  askId: () => string
  /** The backend clock when the run starts, epoch ms. */
  now: number
}

/** A canned run. */
export interface Scenario {
  name: string
  /** Words that pick this scenario. The first match in {@link SCENARIOS} order wins. */
  keywords: readonly string[]
  /** One line for the app's hint list. */
  description: string
  steps(context: ScenarioContext): Step[]
}

/** Facility `User` (1), as core's diagnostics use. */
const USER = 1

const event = (data: WebAgentEvent): Step => ({ kind: "event", event: data })

function diag(severity: DiagnosticEvent["severity"], code: string, message: string): Step {
  return { kind: "diag", diag: { severity, facility: USER, code, message } }
}

/** Split text into word-sized deltas, keeping the spaces. */
function deltas(text: string): string[] {
  return text.match(/\S+\s*|\s+/gu) ?? []
}

function tokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function usage(turn: number, output: string): EventUsage {
  return { inputTokens: 1200 + 650 * turn, outputTokens: tokens(output), cacheReadTokens: 800 }
}

function turnStart(turn: number): Step[] {
  return [
    diag(Severity.Info, "provider.request", `turn ${turn}: request sent to fake-model`),
    event({ type: "turn_started", turn }),
  ]
}

function turnEnd(turn: number, stopReason: "end_turn" | "tool_use", output: string): Step[] {
  return [event({ type: "turn_completed", turn, stopReason, usage: usage(turn, output) })]
}

function streamText(turn: number, index: number, text: string): Step[] {
  return [
    ...deltas(text).map((piece) => event({ type: "text_delta", id: `${turn}:text`, text: piece })),
    event({ type: "item_started", itemType: "text", id: `${turn}:${index}` }),
    event({ type: "item_completed", itemType: "text", id: `${turn}:${index}`, text }),
  ]
}

function streamThinking(turn: number, index: number, text: string): Step[] {
  return [
    ...deltas(text).map((piece) =>
      event({ type: "thinking_delta", id: `${turn}:thinking`, text: piece }),
    ),
    event({ type: "item_started", itemType: "thinking", id: `${turn}:${index}` }),
    event({ type: "item_completed", itemType: "thinking", id: `${turn}:${index}`, text }),
  ]
}

/** The `tool_use` item of a model response. */
function toolUse(callId: string, toolName: string): Step[] {
  return [
    event({ type: "item_started", itemType: "tool_use", id: callId }),
    event({ type: "item_completed", itemType: "tool_use", id: callId, text: toolName }),
  ]
}

interface ToolRun {
  callId: string
  toolName: string
  input: string
  lines: readonly string[]
  durationMs: number
  summary: string
}

/** One executed tool: `tool_call`, its output lines, then `tool_result` with the S19 facts. */
function runTool(tool: ToolRun): Step[] {
  let totalBytes = 0
  const output = tool.lines.map((line) => {
    totalBytes += line.length + 1
    return event({
      type: "tool_output",
      callId: tool.callId,
      toolName: tool.toolName,
      text: `${line}\n`,
      truncated: false,
      totalBytes,
    })
  })
  return [
    diag(Severity.Debug, "tool.dispatch", `${tool.toolName} ${tool.input}`),
    event({
      type: "tool_call",
      callId: tool.callId,
      toolName: tool.toolName,
      inputSummary: tool.input,
    }),
    ...output,
    event({
      type: "tool_result",
      id: tool.callId,
      name: tool.toolName,
      isError: false,
      inputSummary: tool.input,
      outputSummary: tool.summary,
      durationMs: tool.durationMs,
    }),
  ]
}

const finished = (outcome: "completed" | "failed"): Step => event({ type: "run_finished", outcome })

const FAKE_NOTE = "This reply comes from the fake backend: canned events, no model."

/** A text reply with the canned note. The default. */
const TEXT: Scenario = {
  name: "text",
  keywords: [],
  description: "a streamed text reply (the default)",
  steps({ text }) {
    const reply = `${FAKE_NOTE} You wrote: "${text.trim().slice(0, 200)}".`
    return [
      ...turnStart(1),
      ...streamText(1, 0, reply),
      ...turnEnd(1, "end_turn", reply),
      finished("completed"),
    ]
  },
}

/** One tool round, then the answer. */
const TOOL: Scenario = {
  name: "tool",
  keywords: ["tool", "read", "file"],
  description: "reads a file with a tool, then answers",
  steps({ callId }) {
    const id = callId()
    const intro = "I will read the file first."
    const answer = `${FAKE_NOTE} The file has three lines.`
    return [
      ...turnStart(1),
      ...streamText(1, 0, intro),
      ...toolUse(id, "Read"),
      ...runTool({
        callId: id,
        toolName: "Read",
        input: "README.md",
        lines: ["# fake project", "", "Nothing here is real."],
        durationMs: 42,
        summary: "3 lines",
      }),
      ...turnEnd(1, "tool_use", intro),
      ...turnStart(2),
      ...streamText(2, 0, answer),
      ...turnEnd(2, "end_turn", answer),
      finished("completed"),
    ]
  },
}

/** A tool that asks for approval first. */
const APPROVAL: Scenario = {
  name: "approval",
  keywords: ["approve", "approval", "delete", "remove"],
  description: "asks to approve a command before it runs",
  steps({ callId, askId }) {
    const id = callId()
    const intro = "Deleting dist cannot be undone, so I will ask first."
    const after = (approved: boolean): Step[] => {
      const reply = approved
        ? `${FAKE_NOTE} Removed the dist folder.`
        : `${FAKE_NOTE} Okay, I left the dist folder in place.`
      const tool: Step[] = approved
        ? runTool({
            callId: id,
            toolName: "Bash",
            input: "rm -rf dist",
            lines: ["removed dist/index.html", "removed dist/assets/app.js"],
            durationMs: 120,
            summary: "2 files removed",
          })
        : [
            diag(Severity.Notice, "tool.denied", "Bash call denied by the person"),
            event({
              type: "tool_result",
              id,
              name: "Bash",
              isError: true,
              outputSummary: "denied",
            }),
          ]
      return [
        ...tool,
        ...turnEnd(1, "tool_use", intro),
        ...turnStart(2),
        ...streamText(2, 0, reply),
        ...turnEnd(2, "end_turn", reply),
        finished("completed"),
      ]
    }
    return [
      ...turnStart(1),
      ...streamText(1, 0, intro),
      ...toolUse(id, "Bash"),
      {
        kind: "ask",
        ask: {
          type: "ask_user",
          askId: askId(),
          kind: "approval",
          question: "Run rm -rf dist?",
          callId: id,
          toolName: "Bash",
          inputSummary: "rm -rf dist",
        },
        next: (answer) => after(answer.kind === "approval" && answer.approved),
      },
    ]
  },
}

/** A free-form question. */
const QUESTION: Scenario = {
  name: "question",
  keywords: ["question", "ask", "choose"],
  description: "asks a free-form question and uses the answer",
  steps({ askId }) {
    return [
      ...turnStart(1),
      {
        kind: "ask",
        ask: {
          type: "ask_user",
          askId: askId(),
          kind: "question",
          question: "Which branch should I use?",
          options: ["main", "dev"],
        },
        next: (answer) => {
          const choice = answer.kind === "text" ? answer.text : "main"
          const reply = `${FAKE_NOTE} Using the branch "${choice}".`
          return [
            ...streamText(1, 0, reply),
            ...turnEnd(1, "end_turn", reply),
            finished("completed"),
          ]
        },
      },
    ]
  },
}

/** Reasoning first, then the answer. */
const REASONING: Scenario = {
  name: "reasoning",
  keywords: ["think", "reason", "reasoning"],
  description: "thinks out loud, then answers",
  steps() {
    const thought =
      "The person wants to see reasoning. The fake backend has no model, so this thought is canned too."
    const reply = `${FAKE_NOTE} Here is a short answer after some canned thinking.`
    return [
      ...turnStart(1),
      ...streamThinking(1, 0, thought),
      ...streamText(1, 1, reply),
      ...turnEnd(1, "end_turn", thought + reply),
      finished("completed"),
    ]
  },
}

/** Two retries and a quota wait before the reply (spec 2.2). */
const RETRY: Scenario = {
  name: "retry",
  keywords: ["retry", "quota", "wait"],
  description: "retries twice and waits for quota before it answers",
  steps({ now }) {
    const reply = `${FAKE_NOTE} Answered after two retries and a quota wait.`
    const resetAt = now + 60_000
    return [
      ...turnStart(1),
      diag(Severity.Warning, "transport.retry", "attempt 1 failed: overloaded"),
      event({
        type: "status",
        phase: "retrying",
        attempt: 1,
        nextDelayMs: 1000,
        cause: "overloaded",
      }),
      { kind: "pause", ms: 50 },
      diag(Severity.Warning, "transport.retry", "attempt 2 failed: overloaded"),
      event({
        type: "status",
        phase: "retrying",
        attempt: 2,
        nextDelayMs: 2000,
        cause: "overloaded",
      }),
      { kind: "pause", ms: 50 },
      event({ type: "quota", provider: "fake", used: 100, limit: 100, resetAt }),
      diag(Severity.Notice, "quota.wait", "quota exhausted; waiting for the reset"),
      event({ type: "status", phase: "waiting_for_quota", resetAt }),
      { kind: "pause", ms: 50 },
      event({ type: "status", phase: "stream" }),
      ...streamText(1, 0, reply),
      ...turnEnd(1, "end_turn", reply),
      finished("completed"),
    ]
  },
}

/** A provider error after some text. */
const ERROR: Scenario = {
  name: "error",
  keywords: ["error", "fail"],
  description: "fails with a provider error",
  steps() {
    return [
      ...turnStart(1),
      ...deltas("Starting the work").map((piece) =>
        event({ type: "text_delta", id: "1:text", text: piece }),
      ),
      diag(Severity.Error, "provider.error", "fake provider rejected the credential"),
      event({
        type: "error",
        message: "The fake provider rejected the credential.",
        code: "auth_invalid",
        hint: "This is a canned error from the fake backend.",
      }),
      finished("failed"),
    ]
  },
}

/** A long run: three tool rounds and a long reply. For abort and reload. */
const LONG: Scenario = {
  name: "long",
  keywords: ["long", "slow"],
  description: "a long run with three tool rounds",
  steps({ callId }) {
    const steps: Step[] = []
    for (let turn = 1; turn <= 3; turn++) {
      const id = callId()
      const intro = `Round ${turn}: checking part ${turn} of the project.`
      steps.push(
        ...turnStart(turn),
        ...streamText(turn, 0, intro),
        ...toolUse(id, "Grep"),
        ...runTool({
          callId: id,
          toolName: "Grep",
          input: `pattern-${turn}`,
          lines: [`src/part-${turn}.ts:1: match`, `src/part-${turn}.ts:9: match`],
          durationMs: 30 * turn,
          summary: "2 matches",
        }),
        ...turnEnd(turn, "tool_use", intro),
      )
    }
    const words = Array.from({ length: 60 }, (_, index) => `word${index + 1}`).join(" ")
    const reply = `${FAKE_NOTE} ${words}.`
    steps.push(...turnStart(4), ...streamText(4, 0, reply), ...turnEnd(4, "end_turn", reply))
    steps.push(finished("completed"))
    return steps
  },
}

/** Every scenario. Keyword matching follows this order; the text scenario is the fallback. */
export const SCENARIOS: readonly Scenario[] = [
  APPROVAL,
  QUESTION,
  TOOL,
  REASONING,
  RETRY,
  ERROR,
  LONG,
  TEXT,
]

/** The scenario for a message: the first whose keyword is a word of the message. */
export function pickScenario(text: string): Scenario {
  const words = new Set(text.toLowerCase().match(/[a-z]+/gu) ?? [])
  return SCENARIOS.find((scenario) => scenario.keywords.some((word) => words.has(word))) ?? TEXT
}
