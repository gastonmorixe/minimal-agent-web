/**
 * The parts of an assistant message, drawn with the AI Elements patterns
 * from the shadcn/ui registry (D23):
 *
 * - Reasoning: a collapsible Trace line (`/docs/ai-elements/radix/reasoning`).
 * - Tool: a Trace line per call, mapped from the part state as the Tool
 *   pattern's state table says, with the output in a Code Block
 *   (`/docs/ai-elements/radix/tool`).
 * - Confirmation: a pending approval or question is an Item with actions,
 *   outside the Trace (`/docs/ai-elements/radix/confirmation`).
 *
 * Parts render in stream order. Runs of reasoning and tool parts share one
 * Trace, so text written between two tool rounds stays where it was said.
 *
 * @module chat/message-parts
 */

import {
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  TerminalIcon,
} from "lucide-react"
import * as React from "react"
import type { AskAnswer, AskUserData, ChatMessage, ChatPart } from "@/api/types.ts"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"

type ToolPart = Extract<ChatPart, { type: "dynamic-tool" }>
type ReasoningPart = Extract<ChatPart, { type: "reasoning" }>

/** What the message needs from the chat to answer an ask. */
export interface AskHandlers {
  /** Approve or deny the tool call behind approval `approvalId`. */
  onApproval: (approvalId: string, approved: boolean) => void
  /** Answer a free-form question. */
  onAnswer: (askId: string, answer: AskAnswer) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The tool input as one line: a string as is, anything else as JSON. */
export function toolInputText(input: unknown): string {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return "(input not printable)"
  }
}

/** The text to show for a tool output, and its short facts. */
export function toolOutputView(output: unknown): { text: string; facts: string } {
  if (!isRecord(output)) return { text: toolInputText(output), facts: "" }
  const text = typeof output.text === "string" ? output.text : ""
  const facts: string[] = []
  if (typeof output.summary === "string") facts.push(output.summary)
  if (typeof output.durationMs === "number") facts.push(formatMs(output.durationMs))
  if (output.truncated === true) facts.push("truncated")
  return {
    text: text || (typeof output.summary === "string" ? output.summary : ""),
    facts: facts.join(" · "),
  }
}

/** Milliseconds as `120ms` or `1.2s`. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function ReasoningLine({ part }: { part: ReasoningPart }) {
  const running = part.state === "streaming"
  const [open, setOpen] = React.useState<boolean>()
  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined} data-testid="reasoning">
          <TraceIcon>
            {running ? <LoaderCircleIcon className="animate-spin" /> : <CircleCheckIcon />}
          </TraceIcon>
          <TraceTitle>{running ? "Thinking" : "Thought"}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">{part.text}</TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** One tool call, as the Tool pattern's state table maps it. */
export function ToolLine({ part, streaming }: { part: ToolPart; streaming: boolean }) {
  const subject = [part.toolName, toolInputText(part.input)].filter(Boolean).join(" ")
  const denied =
    part.state === "output-denied" ||
    (part.state === "approval-responded" && !part.approval.approved)
  if (denied) {
    return (
      <TraceLine data-testid="tool" data-state="denied">
        <TraceIcon>
          <TerminalIcon />
        </TraceIcon>
        <TraceTitle>Denied {subject}</TraceTitle>
      </TraceLine>
    )
  }
  if (part.state === "output-available" || part.state === "output-error") {
    const failed = part.state === "output-error"
    const view = failed ? { text: part.errorText, facts: "" } : toolOutputView(part.output)
    const running = !failed && part.preliminary === true && streaming
    return (
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={failed ? "error" : running ? "running" : undefined}
            data-testid="tool"
            data-state={part.state}
          >
            <TraceIcon>
              <TerminalIcon />
            </TraceIcon>
            <TraceTitle>
              {failed ? "Failed to run" : running ? "Running" : "Ran"} {subject}
            </TraceTitle>
            {view.facts && <TraceDescription>{view.facts}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm">
            <CodeBlockContent wrap className="max-h-64">
              {view.text || "(no output)"}
            </CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    )
  }
  // input-streaming, input-available, approved approval-responded: running while the chat streams.
  return (
    <TraceLine status={streaming ? "running" : "error"} data-testid="tool" data-state={part.state}>
      <TraceIcon>
        <TerminalIcon />
      </TraceIcon>
      <TraceTitle>
        {streaming ? "Running" : "Failed to run"} {subject}
      </TraceTitle>
    </TraceLine>
  )
}

/** Confirmation: approve or deny a tool call before it runs. */
export function ApprovalRequest({
  part,
  onApproval,
}: {
  part: ToolPart
  onApproval: AskHandlers["onApproval"]
}) {
  const approvalId = part.approval?.id
  const subject = toolInputText(part.input) || part.toolName
  return (
    <Item variant="outline" size="sm" data-testid="approval">
      <ItemMedia variant="icon">
        <TerminalIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          Run {part.toolName} {toolInputText(part.input)}?
        </ItemTitle>
        <ItemDescription>The agent waits until you answer. Approve runs {subject}.</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          size="sm"
          variant="outline"
          disabled={approvalId === undefined}
          onClick={() => approvalId !== undefined && onApproval(approvalId, false)}
        >
          Deny
        </Button>
        <Button
          size="sm"
          disabled={approvalId === undefined}
          onClick={() => approvalId !== undefined && onApproval(approvalId, true)}
        >
          Approve
        </Button>
      </ItemActions>
    </Item>
  )
}

/** Confirmation for a free-form `ask_user`: options as buttons, or a typed answer. */
export function QuestionRequest({
  data,
  onAnswer,
}: {
  data: AskUserData
  onAnswer: AskHandlers["onAnswer"]
}) {
  const [text, setText] = React.useState("")
  const [sent, setSent] = React.useState<string | null>(null)
  if (data.status === "answered") {
    return (
      <TraceLine data-testid="question" data-state="answered">
        <TraceIcon>
          <MessageCircleQuestionIcon />
        </TraceIcon>
        <TraceTitle>
          {data.question} {data.answer}
        </TraceTitle>
      </TraceLine>
    )
  }
  const answer = (value: string) => {
    if (value.trim().length === 0) return
    setSent(value)
    onAnswer(data.askId, { kind: "text", text: value })
  }
  return (
    <Item variant="outline" size="sm" data-testid="question" data-state="pending">
      <ItemMedia variant="icon">
        <MessageCircleQuestionIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{data.question}</ItemTitle>
        <ItemDescription>
          {sent === null ? "The agent waits until you answer." : `Sending "${sent}"...`}
        </ItemDescription>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            answer(text)
          }}
        >
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type an answer"
            aria-label="Answer"
            className="h-8"
          />
          <Button size="sm" type="submit" disabled={text.trim().length === 0 || sent !== null}>
            Answer
          </Button>
        </form>
      </ItemContent>
      {data.options !== undefined && data.options.length > 0 && (
        <ItemActions>
          {data.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant="outline"
              disabled={sent !== null}
              onClick={() => answer(option)}
            >
              {option}
            </Button>
          ))}
        </ItemActions>
      )}
    </Item>
  )
}

function NoteLine({ children }: { children: React.ReactNode }) {
  return (
    <TraceLine>
      <TraceIcon>
        <InfoIcon />
      </TraceIcon>
      <TraceTitle>{children}</TraceTitle>
    </TraceLine>
  )
}

/** A quota part as one short line. */
function quotaText(data: Extract<ChatPart, { type: "data-usage" }>["data"]): string | null {
  if (data.kind !== "quota") return null
  const used =
    data.used !== undefined && data.limit !== undefined ? ` ${data.used}/${data.limit}` : ""
  const reset =
    data.resetAt === undefined ? "" : `, resets ${new Date(data.resetAt).toLocaleTimeString()}`
  return `Quota ${data.provider}${used}${reset}`
}

type Block = { kind: "activity"; parts: ChatPart[] } | { kind: "part"; part: ChatPart }

/** Group runs of reasoning and tool lines; everything else stands alone. */
function blocks(parts: ChatPart[]): Block[] {
  const out: Block[] = []
  for (const part of parts) {
    const isActivity =
      part.type === "reasoning" ||
      (part.type === "dynamic-tool" && part.state !== "approval-requested") ||
      part.type === "data-notice" ||
      (part.type === "data-usage" && part.data.kind === "quota")
    const last = out.at(-1)
    if (isActivity && last?.kind === "activity") last.parts.push(part)
    else if (isActivity) out.push({ kind: "activity", parts: [part] })
    else out.push({ kind: "part", part })
  }
  return out
}

function ActivityPart({ part, streaming }: { part: ChatPart; streaming: boolean }) {
  switch (part.type) {
    case "reasoning":
      return <ReasoningLine part={part} />
    case "dynamic-tool":
      return <ToolLine part={part} streaming={streaming} />
    case "data-notice":
      return <NoteLine>Notice: {part.data.kind}</NoteLine>
    case "data-usage": {
      const text = quotaText(part.data)
      return text === null ? null : <NoteLine>{text}</NoteLine>
    }
    default:
      return null
  }
}

/** One assistant message: its parts in order. */
export function AssistantParts({
  message,
  streaming,
  handlers,
}: {
  message: ChatMessage
  streaming: boolean
  handlers: AskHandlers
}) {
  return (
    <>
      {blocks(message.parts).map((block, index) => {
        if (block.kind === "activity") {
          return (
            // Blocks have no identity beyond their position in the message.
            // oxlint-disable-next-line react/no-array-index-key
            <Trace key={index}>
              {block.parts.map((part, partIndex) => (
                // oxlint-disable-next-line react/no-array-index-key
                <ActivityPart key={partIndex} part={part} streaming={streaming} />
              ))}
            </Trace>
          )
        }
        const { part } = block
        switch (part.type) {
          case "text":
            return (
              // oxlint-disable-next-line react/no-array-index-key
              <p key={index} className="whitespace-pre-wrap" data-testid="reply-text">
                {part.text}
              </p>
            )
          case "dynamic-tool":
            return (
              <ApprovalRequest key={part.toolCallId} part={part} onApproval={handlers.onApproval} />
            )
          case "data-ask-user":
            return (
              <QuestionRequest
                key={part.data.askId}
                data={part.data}
                onAnswer={handlers.onAnswer}
              />
            )
          default:
            return null
        }
      })}
    </>
  )
}
