import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import {
  type ChatStreamInput,
  type ChatStreamState,
  INITIAL_CHAT_STREAM_STATE,
  mapChatStreamInput,
  toFinishReason,
} from "./adapter.ts"
import type { UiMessageChunk } from "./chunks.ts"
import { GOLDEN_RUNS } from "./golden-runs.ts"
import { ChatStreamEncoder, encodeChatStream, SSE_DONE } from "./sse.ts"

const GOLDEN_DIR = join(import.meta.dir, "goldens")
/** Set `UPDATE_GOLDENS=1` to rewrite the golden files from the current adapter. */
const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === "1"

/** Fold inputs through the reducer and collect every chunk. */
function mapAll(inputs: ChatStreamInput[]): UiMessageChunk[] {
  let state: ChatStreamState = INITIAL_CHAT_STREAM_STATE
  const chunks: UiMessageChunk[] = []
  for (const input of inputs) {
    const step = mapChatStreamInput(state, input)
    state = step.state
    chunks.push(...step.chunks)
  }
  return chunks
}

function events(...list: AgentEvent[]): ChatStreamInput[] {
  return list.map((event) => ({ kind: "event", event }))
}

describe("chat stream goldens (event sequence in, SSE text out)", () => {
  test("covers a text, reasoning, tool, and error run", () => {
    const names = GOLDEN_RUNS.map((run) => run.name)
    expect(names).toEqual(
      expect.arrayContaining(["text-turn", "reasoning-turn", "tool-turn", "error-turn"]),
    )
  })

  for (const run of GOLDEN_RUNS) {
    test(run.name, async () => {
      const actual = encodeChatStream(run.inputs)
      const file = Bun.file(join(GOLDEN_DIR, `${run.name}.sse`))
      if (UPDATE_GOLDENS) await Bun.write(file, actual)
      expect(actual).toBe(await file.text())
    })
  }

  test("every golden run ends with one finish part, then [DONE]", () => {
    for (const run of GOLDEN_RUNS) {
      const frames = encodeChatStream(run.inputs).split("\n\n").filter(Boolean)
      const finishFrames = frames.filter((frame) => frame.startsWith('data: {"type":"finish"'))
      expect(finishFrames).toHaveLength(1)
      expect(frames.at(-2)).toBe(finishFrames[0])
      expect(`${frames.at(-1)}\n\n`).toBe(SSE_DONE)
    }
  })
})

describe("mapChatStreamInput", () => {
  test("does not change the state it is given", () => {
    const state = Object.freeze({ ...INITIAL_CHAT_STREAM_STATE })
    const step = mapChatStreamInput(state, {
      kind: "event",
      event: { type: "turn_started", turn: 1 },
    })
    expect(state).toEqual(INITIAL_CHAT_STREAM_STATE)
    expect(step.state).not.toBe(state)
    expect(step.state.stepOpen).toBe(true)
  })

  test("starts the message before the first event when the host sent no run_started", () => {
    expect(mapAll(events({ type: "turn_started", turn: 1 }))).toEqual([
      { type: "start" },
      { type: "start-step" },
    ])
  })

  test("sends nothing after finish", () => {
    const encoder = new ChatStreamEncoder()
    encoder.push({ kind: "run_started" })
    expect(encoder.end().endsWith(SSE_DONE)).toBe(true)
    expect(encoder.push({ kind: "event", event: { type: "turn_started", turn: 2 } })).toBe("")
    expect(encoder.end()).toBe("")
  })

  test("closes open parts and the step when the run ends early", () => {
    const chunks = mapAll([
      { kind: "run_started" },
      ...events(
        { type: "turn_started", turn: 1 },
        { type: "thinking_delta", id: "1:thinking", text: "hm" },
        { type: "text_delta", id: "1:text", text: "partial" },
      ),
      { kind: "run_ended" },
    ])
    expect(chunks.slice(-4)).toEqual([
      { type: "text-end", id: "1:text" },
      { type: "reasoning-end", id: "1:thinking" },
      { type: "finish-step" },
      { type: "finish" },
    ])
  })

  test("opens a step for deltas that arrive outside a turn (the tool-cap wrap-up)", () => {
    const chunks = mapAll(
      events(
        { type: "turn_started", turn: 3 },
        {
          type: "turn_completed",
          turn: 3,
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        { type: "notice", notice: { kind: "tool_rounds_capped", severity: "warn", cap: 3 } },
        { type: "text_delta", id: "3:text", text: "Wrapping up." },
      ),
    )
    expect(chunks.slice(-4)).toEqual([
      { type: "data-notice", data: { kind: "tool_rounds_capped", severity: "warn", cap: 3 } },
      { type: "start-step" },
      { type: "text-start", id: "3:text" },
      { type: "text-delta", id: "3:text", delta: "Wrapping up." },
    ])
  })

  test("maps a failed tool to tool-output-available with isError", () => {
    const chunks = mapAll(
      events(
        { type: "turn_started", turn: 1 },
        { type: "item_completed", itemType: "tool_use", id: "t1", text: "Bash" },
        { type: "tool_result", id: "t1", name: "Bash", isError: true },
      ),
    )
    expect(chunks.slice(-2)).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "t1",
        toolName: "Bash",
        input: null,
        dynamic: true,
      },
      { type: "tool-output-available", toolCallId: "t1", output: { isError: true }, dynamic: true },
    ])
  })

  test("keeps the error message alone when there is no hint", () => {
    const chunks = mapAll(events({ type: "error", message: "aborted" }))
    expect(chunks).toEqual([{ type: "start" }, { type: "error", errorText: "aborted" }])
  })
})

describe("toFinishReason", () => {
  test("maps every core stop reason", () => {
    expect(toFinishReason(undefined)).toBeUndefined()
    expect(toFinishReason(null)).toBe("other")
    expect(toFinishReason("end_turn")).toBe("stop")
    expect(toFinishReason("stop_sequence")).toBe("stop")
    expect(toFinishReason("tool_use")).toBe("tool-calls")
    expect(toFinishReason("max_tokens")).toBe("length")
    expect(toFinishReason("context_window_exceeded")).toBe("length")
    expect(toFinishReason("refusal")).toBe("content-filter")
    expect(toFinishReason("content_filter")).toBe("content-filter")
    expect(toFinishReason("pause_turn")).toBe("other")
    expect(toFinishReason("error")).toBe("error")
  })
})
