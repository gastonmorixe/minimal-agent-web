import { describe, expect, test } from "bun:test"

import { renderToString } from "react-dom/server"
import type { ChatMessage, HistoryMessage } from "@/api/types.ts"
import { TooltipProvider } from "@/components/ui/tooltip"

import { ContextMeter, contextTokens, lastTurnUsage } from "./context-meter.tsx"
import { decodeHistory } from "./history.ts"
import {
  AskRequest,
  AssistantParts,
  formatMs,
  toolInputText,
  toolOutputView,
} from "./message-parts.tsx"
import { statusText } from "./status-text.ts"

const handlers = { onAnswer: () => {} }

function render(message: ChatMessage, streaming = false): string {
  return renderToString(
    <TooltipProvider>
      <AssistantParts message={message} streaming={streaming} handlers={handlers} />
    </TooltipProvider>,
  )
}

function tool(state: string, extra: Record<string, unknown> = {}): ChatMessage {
  return {
    id: "m",
    role: "assistant",
    parts: [
      // Built as plain JSON, as the stream decoder builds it.
      JSON.parse(
        JSON.stringify({
          type: "dynamic-tool",
          toolName: "Bash",
          toolCallId: "c1",
          state,
          input: "rm -rf dist",
          ...extra,
        }),
      ),
    ],
  }
}

describe("tool parts follow the Tool pattern's state table", () => {
  test("running while the chat streams, failed after it stops", () => {
    expect(render(tool("input-available"), true)).toContain("Running")
    expect(render(tool("input-available"), false)).toContain("Failed to run")
  })

  test("output and error", () => {
    const ran = render(
      tool("output-available", {
        output: { isError: false, summary: "2 removed", durationMs: 120, text: "a\n" },
      }),
    )
    expect(ran).toContain("Ran")
    expect(ran).toContain("2 removed · 120ms")
    expect(render(tool("output-error", { errorText: "no such file" }))).toContain("Failed to run")
  })
})

describe("a preflight ask (Confirmation)", () => {
  const data = {
    askId: "ask_1",
    code: "signed_thinking_mismatch",
    title: "Thinking signed by another model",
    detail: "Keep it or drop it?",
    options: [
      { id: "keep", label: "Keep it", isDefault: true },
      { id: "drop", label: "Drop it", destructive: true },
    ],
  }

  test("shows its title, detail, and every option, with Decline", () => {
    const html = renderToString(
      <TooltipProvider>
        <AskRequest data={data} onAnswer={() => {}} />
      </TooltipProvider>,
    )
    expect(html).toContain('data-testid="ask"')
    expect(html).toContain("Thinking signed by another model")
    expect(html).toContain("Keep it or drop it?")
    expect(html).toContain("Keep it")
    expect(html).toContain("Drop it")
    expect(html).toContain("Decline")
  })

  test("renders inside an assistant message too, via AssistantParts", () => {
    const html = render({
      id: "m",
      role: "assistant",
      parts: [{ type: "data-ask-user", id: data.askId, data }],
    })
    expect(html).toContain('data-testid="ask"')
    expect(html).toContain("Thinking signed by another model")
  })
})

describe("helpers", () => {
  test("format tool input, output, and durations", () => {
    expect(toolInputText(null)).toBe("")
    expect(toolInputText({ path: "a" })).toBe('{"path":"a"}')
    expect(toolOutputView({ text: "x", truncated: true, totalBytes: 9 })).toEqual({
      text: "x",
      facts: "truncated",
    })
    expect(toolOutputView({ isError: false })).toEqual({ text: "", facts: "" })
    expect(formatMs(42)).toBe("42ms")
    expect(formatMs(1500)).toBe("1.5s")
  })

  test("label status phases, unknown ones as their code", () => {
    expect(
      statusText({ phase: "retrying", attempt: 2, nextDelayMs: 2000, cause: "overloaded" }),
    ).toBe("Retrying in 2s, attempt 3 (overloaded)")
    expect(statusText({ phase: "running_tool", toolName: "Bash" })).toBe("Running Bash")
    expect(statusText({ phase: "brand_new_phase" })).toBe("brand_new_phase")
  })
})

describe("Context", () => {
  const messages: ChatMessage[] = [
    {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "data-usage",
          data: { kind: "turn", turn: 1, usage: { inputTokens: 1, outputTokens: 1 } },
        },
        {
          type: "data-usage",
          data: {
            kind: "turn",
            turn: 2,
            usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 500 },
          },
        },
      ],
    },
  ]

  test("uses the last round's usage against the window", () => {
    const usage = lastTurnUsage(messages)
    expect(usage?.inputTokens).toBe(1000)
    expect(usage === null ? 0 : contextTokens(usage)).toBe(2000)
    expect(renderToString(<ContextMeter messages={messages} limit={200_000} />)).toContain(
      "1<!-- -->% context",
    )
    expect(lastTurnUsage([])).toBeNull()
  })
})

describe("decodeHistory", () => {
  test("decodes a run's parts with the AI SDK, and keeps its errors", async () => {
    const history: HistoryMessage[] = [
      { id: "user-0", role: "user", text: "hi" },
      {
        id: "msg-0",
        role: "assistant",
        running: false,
        chunks: [
          { type: "start", messageId: "msg-0" },
          { type: "start-step" },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Hello" },
          { type: "text-end", id: "t" },
          { type: "error", errorText: "aborted" },
          { type: "finish-step" },
          { type: "finish", finishReason: "other" },
        ],
      },
    ]
    const decoded = await decodeHistory(history)
    expect(decoded[0]?.message).toEqual({
      id: "user-0",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    })
    expect(decoded[1]?.message.parts).toMatchObject([
      { type: "step-start" },
      { type: "text", text: "Hello" },
    ])
    expect(decoded[1]?.errors).toEqual(["aborted"])
  })
})
