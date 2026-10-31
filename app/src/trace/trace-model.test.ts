import { describe, expect, test } from "bun:test"

import type { EventData, SessionEntry } from "@/api/types.ts"

import { filterDiagnostics, severityName } from "./diagnostics.tsx"
import { waitText } from "./timeline.tsx"
import { buildTrace } from "./trace-model.ts"
import { niceMax, tickLabel } from "./usage-chart.tsx"

let seq = 0

function ev(data: EventData, ts = 1000 + seq * 10): SessionEntry {
  return { v: 1, seq: seq++, ts, sessionId: "s", ch: "event", data }
}

function diag(severity: number, code: string): SessionEntry {
  return {
    v: 1,
    seq: seq++,
    ts: 1000 + seq * 10,
    sessionId: "s",
    ch: "diag",
    data: { severity, facility: 1, code, message: code },
  }
}

const usage = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 5,
})

function session(): SessionEntry[] {
  seq = 0
  return [
    ev({ type: "user_message", text: "clean up" }),
    diag(6, "provider.request"),
    ev({ type: "turn_started", turn: 1 }),
    ev({ type: "thinking_delta", id: "1:thinking", text: "hm" }),
    ev({ type: "status", phase: "retrying", attempt: 1, nextDelayMs: 1000, cause: "overloaded" }),
    diag(4, "transport.retry"),
    ev({ type: "quota", provider: "fake", used: 100, limit: 100, resetAt: 5000 }),
    ev({ type: "status", phase: "waiting_for_quota", resetAt: 5000 }),
    ev({ type: "item_completed", itemType: "tool_use", id: "c1", text: "Bash" }),
    ev({
      type: "ask_user",
      askId: "a1",
      kind: "approval",
      question: "Run it?",
      callId: "c1",
      toolName: "Bash",
    }),
    ev({ type: "ask_answered", askId: "a1", answer: { kind: "approval", approved: true } }),
    ev({ type: "tool_call", callId: "c1", toolName: "Bash", inputSummary: "rm -rf dist" }),
    ev({ type: "tool_output", callId: "c1", toolName: "Bash", text: "a\n" }),
    ev({ type: "tool_output", callId: "c1", toolName: "Bash", text: "b\n" }),
    ev({
      type: "tool_result",
      id: "c1",
      name: "Bash",
      isError: false,
      outputSummary: "2 removed",
      durationMs: 120,
    }),
    ev({ type: "item_completed", itemType: "tool_use", id: "c2", text: "Read" }),
    ev({ type: "tool_result", id: "c2", name: "Read", isError: true }),
    ev({ type: "turn_completed", turn: 1, stopReason: "tool_use", usage: usage(100, 10) }),
    ev({ type: "turn_started", turn: 2 }),
    ev({ type: "text_delta", id: "2:text", text: "Done." }),
    ev({ type: "some_future_kind", value: 1 }),
    ev({ type: "turn_completed", turn: 2, stopReason: "end_turn", usage: usage(150, 4) }),
    ev({ type: "run_finished", outcome: "completed" }),
    ev({ type: "user_message", text: "again" }),
    ev({ type: "turn_started", turn: 1 }),
    diag(3, "provider.error"),
    ev({ type: "error", message: "boom" }),
  ]
}

describe("buildTrace", () => {
  const model = buildTrace(session())

  test("splits runs at user messages and records the outcome", () => {
    expect(model.runs.map((run) => [run.index, run.userText, run.outcome])).toEqual([
      [1, "clean up", "completed"],
      [2, "again", undefined],
    ])
    expect(model.runs[1]?.error).toBe("boom")
    expect(model.runs[0]?.endedAt).toBeDefined()
    expect(model.runs[1]?.endedAt).toBeUndefined()
    expect(model.lastSeq).toBe(seq - 1)
  })

  test("builds rounds with stop reason, usage, reasoning, and text", () => {
    const [first, second] = model.runs[0]?.rounds ?? []
    expect(first).toMatchObject({
      turn: 1,
      stopReason: "tool_use",
      reasoning: true,
      usage: { inputTokens: 100 },
    })
    expect(second).toMatchObject({ turn: 2, stopReason: "end_turn", textChars: 5 })
    expect(model.runs[1]?.rounds[0]?.endedAt).toBeUndefined()
  })

  test("collects tool calls with input, output, duration, approval, and state", () => {
    const tools = model.runs[0]?.rounds[0]?.tools ?? []
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      callId: "c1",
      toolName: "Bash",
      input: "rm -rf dist",
      output: "a\nb\n",
      summary: "2 removed",
      durationMs: 120,
      approval: "approved",
      state: "done",
    })
    // Without durationMs, the duration is the time between the entries.
    expect(tools[1]).toMatchObject({ callId: "c2", state: "error", durationMs: 10 })
  })

  test("records retries, quota waits, and asks in the round", () => {
    const waits = model.runs[0]?.rounds[0]?.waits ?? []
    expect(waits.map((wait) => wait.kind)).toEqual(["retry", "quota", "quota", "ask"])
    expect(waits[0]).toMatchObject({ attempt: 1, nextDelayMs: 1000, cause: "overloaded" })
    expect(waits[1]).toMatchObject({ provider: "fake", used: 100, limit: 100 })
    expect(waits[3]).toMatchObject({ question: "Run it?", answer: "approved" })
    expect(waitText(waits[0] ?? { seq: 0, ts: 0, kind: "host" })).toBe(
      "Retry after attempt 1 (overloaded), next try in 1.0s",
    )
  })

  test("lists diagnostics and usage with running totals", () => {
    expect(model.diagnostics.map((item) => item.code)).toEqual([
      "provider.request",
      "transport.retry",
      "provider.error",
    ])
    expect(model.usage.map((point) => [point.turn, point.totalInput, point.totalOutput])).toEqual([
      [1, 100, 10],
      [2, 250, 14],
    ])
  })

  test("a deny marks the call denied", () => {
    seq = 0
    const denied = buildTrace([
      ev({ type: "user_message", text: "x" }),
      ev({ type: "turn_started", turn: 1 }),
      ev({ type: "item_completed", itemType: "tool_use", id: "c", text: "Bash" }),
      ev({ type: "ask_user", askId: "a", kind: "approval", question: "?", callId: "c" }),
      ev({ type: "ask_answered", askId: "a", answer: { kind: "approval", approved: false } }),
      ev({ type: "tool_result", id: "c", name: "Bash", isError: true }),
    ])
    expect(denied.runs[0]?.rounds[0]?.tools[0]).toMatchObject({
      approval: "denied",
      state: "denied",
    })
  })

  test("the same entries always build the same model (reload replays from seq 0)", () => {
    expect(buildTrace(session())).toEqual(buildTrace(session()))
  })
})

describe("diagnostics filter", () => {
  test("keeps the chosen severity and everything more severe", () => {
    const { diagnostics } = buildTrace(session())
    expect(filterDiagnostics(diagnostics, 7)).toHaveLength(3)
    expect(filterDiagnostics(diagnostics, 4).map((item) => item.code)).toEqual([
      "transport.retry",
      "provider.error",
    ])
    expect(filterDiagnostics(diagnostics, 3).map((item) => item.code)).toEqual(["provider.error"])
    expect(filterDiagnostics(diagnostics, 0)).toEqual([])
    expect(severityName(4)).toBe("warning")
    expect(severityName(9)).toBe("severity 9")
  })
})

describe("usage chart scale", () => {
  test("rounds the axis up and labels ticks", () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(2300)).toBe(2500)
    expect(niceMax(2600)).toBe(5000)
    expect(niceMax(13)).toBe(20)
    expect(tickLabel(2500)).toBe("2,500")
    expect(tickLabel(25_000)).toBe("25K")
    expect(tickLabel(2_500_000)).toBe("2.5M")
  })
})
