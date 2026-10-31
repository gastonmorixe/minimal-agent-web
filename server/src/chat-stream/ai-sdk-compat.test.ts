/**
 * Checks the chat stream against the AI SDK itself (`ai`, a dev dependency
 * used only by tests): the part types, the headers, the SSE framing, and the
 * client decode path that `useChat` runs (`DefaultChatTransport`, then
 * `readUIMessageStream`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import {
  UI_MESSAGE_STREAM_HEADERS as AI_SDK_HEADERS,
  DefaultChatTransport,
  type FinishReason,
  JsonToSseTransformStream,
  readUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
} from "ai"

import {
  type ChatDataTypes,
  UI_MESSAGE_STREAM_HEADERS,
  type UiFinishReason,
  type UiMessageChunk,
} from "./chunks.ts"
import { GOLDEN_RUNS } from "./golden-runs.ts"
import { encodeChatStream } from "./sse.ts"

type Assignable<A, B> = [A] extends [B] ? true : false

// Compile-time checks: a mismatch makes these assignments type errors.
const chunksConform: Assignable<UiMessageChunk, UIMessageChunk<unknown, ChatDataTypes>> = true
const finishReasonsCovered: Assignable<UiFinishReason, FinishReason> = true
const finishReasonsComplete: Assignable<FinishReason, UiFinishReason> = true

type ChatMessage = UIMessage<unknown, ChatDataTypes>

function goldenInputs(name: string) {
  const run = GOLDEN_RUNS.find((candidate) => candidate.name === name)
  if (run === undefined) throw new Error(`no golden run named ${name}`)
  return run.inputs
}

/** Parse our SSE text back into the JSON parts it carries. */
function parseSse(sse: string): unknown[] {
  return sse
    .split("\n\n")
    .filter((frame) => frame.length > 0 && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)))
}

function streamOf(values: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value)
      controller.close()
    },
  })
}

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  // Serves each golden run's SSE at /<name>, the way the messages route will.
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const name = new URL(request.url).pathname.slice(1)
      return new Response(encodeChatStream(goldenInputs(name)), {
        headers: UI_MESSAGE_STREAM_HEADERS,
      })
    },
  })
})

afterAll(() => {
  void server.stop(true)
})

/** Read a golden run through the same client path `useChat` uses. */
async function decode(
  name: string,
): Promise<{ message: ChatMessage | undefined; errors: string[] }> {
  const transport = new DefaultChatTransport<ChatMessage>({ api: new URL(name, server.url).href })
  const stream = await transport.sendMessages({
    trigger: "submit-message",
    chatId: "chat-1",
    messageId: undefined,
    messages: [],
    abortSignal: undefined,
  })
  const errors: string[] = []
  let message: ChatMessage | undefined
  for await (const snapshot of readUIMessageStream<ChatMessage>({
    stream,
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  })) {
    message = snapshot
  }
  return { message, errors }
}

describe("AI SDK compatibility", () => {
  test("part types and finish reasons match the ai package types", () => {
    expect(chunksConform).toBe(true)
    expect(finishReasonsCovered).toBe(true)
    expect(finishReasonsComplete).toBe(true)
  })

  test("headers match the AI SDK's UI message stream headers", () => {
    expect(AI_SDK_HEADERS).toEqual(UI_MESSAGE_STREAM_HEADERS)
    expect(UI_MESSAGE_STREAM_HEADERS["x-vercel-ai-ui-message-stream"]).toBe("v1")
  })

  test("SSE text is byte-identical to the AI SDK's JsonToSseTransformStream", async () => {
    for (const run of GOLDEN_RUNS) {
      const ours = encodeChatStream(run.inputs)
      const theirs = await new Response(
        streamOf(parseSse(ours)).pipeThrough(new JsonToSseTransformStream()),
      ).text()
      expect(ours).toBe(theirs)
    }
  })

  test("text turn decodes to one text part", async () => {
    const { message, errors } = await decode("text-turn")
    expect(errors).toEqual([])
    expect(message).toMatchObject({
      id: "msg-text",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "Hello, world.", state: "done" },
        {
          type: "data-usage",
          data: { kind: "turn", turn: 1, usage: { inputTokens: 12, outputTokens: 4 } },
        },
      ],
    })
  })

  test("reasoning turn decodes to a reasoning part, then text", async () => {
    const { message, errors } = await decode("reasoning-turn")
    expect(errors).toEqual([])
    expect(message?.parts).toMatchObject([
      { type: "step-start" },
      { type: "reasoning", text: "The user wants a short answer.", state: "done" },
      { type: "text", text: "Short answer.", state: "done" },
      { type: "data-usage", data: { turn: 1 } },
    ])
  })

  test("tool turn decodes to a dynamic tool with its output, across two steps", async () => {
    const { message, errors } = await decode("tool-turn")
    expect(errors).toEqual([])
    expect(message?.parts).toMatchObject([
      { type: "step-start" },
      { type: "text", text: "Let me read it.", state: "done" },
      {
        type: "dynamic-tool",
        toolName: "Read",
        toolCallId: "toolu_01",
        state: "output-available",
        input: null,
        output: { isError: false },
      },
      { type: "data-usage", data: { turn: 1 } },
      { type: "step-start" },
      { type: "text", text: "The file has three lines.", state: "done" },
      { type: "data-usage", data: { turn: 2 } },
    ])
  })

  test("error run surfaces errorText and keeps the partial text", async () => {
    const { message, errors } = await decode("error-turn")
    expect(errors).toEqual(["The provider rejected the credential.\nLog in again."])
    expect(message?.parts).toMatchObject([
      { type: "step-start" },
      { type: "text", text: "Working on", state: "done" },
    ])
  })

  test("buffered run with a continuation decodes the notice and both steps", async () => {
    const { message, errors } = await decode("buffered-continuation")
    expect(errors).toEqual([])
    expect(message?.parts).toMatchObject([
      { type: "step-start" },
      { type: "reasoning", text: "Plan the list.", state: "done" },
      { type: "text", text: "1. Install", state: "done" },
      { type: "data-notice", data: { kind: "max_tokens_continuing", attempt: 1 } },
      { type: "step-start" },
      { type: "text", text: "\n2. Run", state: "done" },
      { type: "data-usage", data: { turn: 2 } },
    ])
  })

  test("approval run decodes to an approved tool with its streamed and final output", async () => {
    const { message, errors } = await decode("approval-turn")
    expect(errors).toEqual([])
    expect(message?.parts).toMatchObject([
      { type: "step-start" },
      {
        type: "dynamic-tool",
        toolName: "Bash",
        toolCallId: "toolu_02",
        state: "output-available",
        input: "rm -rf dist",
        approval: { id: "ask_1", approved: true },
        output: {
          isError: false,
          summary: "2 files removed",
          durationMs: 120,
          text: "removed dist/a.js\nremoved dist/b.js\n",
        },
      },
      { type: "data-usage", data: { turn: 1 } },
      { type: "step-start" },
      { type: "text", text: "Removed the dist folder.", state: "done" },
      { type: "data-usage", data: { turn: 2 } },
    ])
  })

  test("denied run decodes to an output-denied tool with the reason", async () => {
    const { message, errors } = await decode("denied-turn")
    expect(errors).toEqual([])
    expect(message?.parts[1]).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "toolu_03",
      state: "output-denied",
      approval: { id: "ask_2", approved: false, reason: "Keep it." },
    })
  })

  test("question run decodes to one ask-user part, updated in place with the answer", async () => {
    const { message, errors } = await decode("question-turn")
    expect(errors).toEqual([])
    const asks = message?.parts.filter((part) => part.type === "data-ask-user") ?? []
    expect(asks).toEqual([
      {
        type: "data-ask-user",
        id: "ask_3",
        data: {
          askId: "ask_3",
          question: "Which branch?",
          options: ["main", "dev"],
          status: "answered",
          answer: "dev",
        },
      },
    ])
  })

  test("retry run keeps status out of the message and the quota as usage", async () => {
    const { message, errors } = await decode("retry-turn")
    expect(errors).toEqual([])
    expect(message?.parts.some((part) => part.type === "data-status")).toBe(false)
    expect(message?.parts).toMatchObject([
      { type: "step-start" },
      { type: "data-usage", id: "quota:fake", data: { kind: "quota", provider: "fake" } },
      { type: "text", text: "Done after the wait.", state: "done" },
      { type: "data-usage", data: { kind: "turn", turn: 1 } },
    ])
  })

  test("the client ignores SSE comments, so keep-alives are safe mid-stream", async () => {
    const sse = encodeChatStream(goldenInputs("text-turn"))
    const withComments = sse.replace("\n\n", "\n\n: keep-alive\n\n")
    const keepAliveServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(withComments, { headers: UI_MESSAGE_STREAM_HEADERS }),
    })
    try {
      const transport = new DefaultChatTransport<ChatMessage>({ api: keepAliveServer.url.href })
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      })
      let last: ChatMessage | undefined
      for await (const snapshot of readUIMessageStream<ChatMessage>({ stream })) last = snapshot
      expect(last?.parts).toMatchObject([
        { type: "step-start" },
        { type: "text", text: "Hello, world." },
        { type: "data-usage" },
      ])
    } finally {
      void keepAliveServer.stop(true)
    }
  })
})
