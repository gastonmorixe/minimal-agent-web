/**
 * The parts of an assistant message, drawn with the AI Elements patterns
 * from the shadcn/ui registry (D23):
 *
 * - Reasoning: a collapsible Trace line (`/docs/ai-elements/radix/reasoning`).
 * - Tool: a Trace line per call, mapped from the part state as the Tool
 *   pattern's state table says, with the output in a Code Block
 *   (`/docs/ai-elements/radix/tool`). Today's sessions never produce a tool
 *   call (`backend/runtime-backend.ts`'s "no tools" scope note); this stays
 *   ready for when one passes a `toolRegistry`.
 * - Confirmation: a pending ask is an Item with actions, outside the Trace
 *   (`/docs/ai-elements/radix/confirmation`). Core's `ask_user` (spec v1 S17)
 *   is a plain multiple-choice question, never a tool approval — core has no
 *   tool-approval concept at all — so this answers with one of the ask's
 *   option ids, not an approve/deny boolean.
 *
 * Parts render in stream order. Runs of reasoning and tool parts share one
 * Trace, so text written between two tool rounds stays where it was said.
 *
 * @module chat/message-parts
 */

import { CircleCheckIcon, InfoIcon, LoaderCircleIcon, TerminalIcon } from "lucide-react"
import * as React from "react"
import type { AskUserData, ChatMessage, ChatPart } from "@/api/types.ts"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
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
  /** Answer ask `askId` with the id of the chosen option, or `null` to decline. */
  onAnswer: (askId: string, answer: string | null) => void
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

/** One tool call, as the Tool pattern's state table maps it. No approval state exists (see the module doc). */
export function ToolLine({ part, streaming }: { part: ToolPart; streaming: boolean }) {
  const subject = [part.toolName, toolInputText(part.input)].filter(Boolean).join(" ")
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
  // input-streaming, input-available: running while the chat streams.
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

/** Confirmation for a preflight ask: its options as buttons, each answering with that option's id. */
export function AskRequest({
  data,
  onAnswer,
}: {
  data: AskUserData
  onAnswer: AskHandlers["onAnswer"]
}) {
  const [sent, setSent] = React.useState<string | null>(null)
  const answer = (optionId: string | null): void => {
    setSent(optionId)
    onAnswer(data.askId, optionId)
  }
  return (
    <Item variant="outline" size="sm" data-testid="ask">
      <ItemMedia variant="icon">
        <TerminalIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{data.title}</ItemTitle>
        <ItemDescription className="whitespace-pre-wrap">
          {sent === null ? data.detail : `Answered "${sent}".`}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="outline" disabled={sent !== null} onClick={() => answer(null)}>
          Decline
        </Button>
        {data.options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.destructive === true ? "destructive" : "default"}
            disabled={sent !== null}
            onClick={() => answer(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </ItemActions>
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
      part.type === "dynamic-tool" ||
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
          case "data-ask-user":
            return (
              <AskRequest key={part.data.askId} data={part.data} onAnswer={handlers.onAnswer} />
            )
          default:
            return null
        }
      })}
    </>
  )
}
