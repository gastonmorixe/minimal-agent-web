/**
 * The trace timeline: runs, their rounds, tool calls, and waits.
 *
 * Built on Trace patterns from the shadcn/ui registry: a run is a Chain of
 * Thought (`/docs/ai-elements/radix/chain-of-thought`), a summary line that
 * expands into its rounds. A round is a Task (`/docs/ai-elements/radix/task`)
 * with its tool calls and waits nested under it. A tool call is a Tool line
 * whose input and output open in a Code Block.
 *
 * @module trace/timeline
 */

import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ClockIcon,
  GaugeIcon,
  MessageCircleQuestionIcon,
  RotateCwIcon,
  TerminalIcon,
} from "lucide-react"
import { formatMs } from "@/chat/message-parts.tsx"
import { Badge } from "@/components/ui/badge"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
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

import type { TraceRound, TraceRun, TraceTool, TraceWait } from "./trace-model.ts"

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function span(start: number, end: number | undefined): string {
  return end === undefined ? "running" : formatMs(end - start)
}

/** One wait as a line of text. */
export function waitText(wait: TraceWait): string {
  switch (wait.kind) {
    case "retry": {
      const delay =
        wait.nextDelayMs === undefined ? "" : `, next try in ${formatMs(wait.nextDelayMs)}`
      return `Retry after attempt ${wait.attempt ?? "?"}${wait.cause ? ` (${wait.cause})` : ""}${delay}`
    }
    case "quota": {
      const usage =
        wait.used !== undefined && wait.limit !== undefined ? ` ${wait.used}/${wait.limit}` : ""
      const reset = wait.resetAt === undefined ? "" : ` until ${time(wait.resetAt)}`
      return wait.provider !== undefined
        ? `Quota ${wait.provider}${usage}${reset}`
        : `Waiting for quota${reset}`
    }
    case "host":
      return "Paused, waiting for the host"
    case "ask":
      return wait.answer === undefined
        ? `Asked: ${wait.question ?? ""} (waiting)`
        : `Asked: ${wait.question ?? ""} Answer: ${wait.answer}`
    default:
      return wait.kind
  }
}

function WaitLine({ wait }: { wait: TraceWait }) {
  const icon =
    wait.kind === "retry" ? (
      <RotateCwIcon />
    ) : wait.kind === "quota" ? (
      <GaugeIcon />
    ) : wait.kind === "ask" ? (
      <MessageCircleQuestionIcon />
    ) : (
      <ClockIcon />
    )
  return (
    <TraceLine data-testid="trace-wait" data-kind={wait.kind}>
      <TraceIcon>{icon}</TraceIcon>
      <TraceTitle>{waitText(wait)}</TraceTitle>
      <TraceDescription>#{wait.seq}</TraceDescription>
    </TraceLine>
  )
}

function ToolTraceLine({ tool }: { tool: TraceTool }) {
  const title = [tool.toolName, tool.input].filter(Boolean).join(" ")
  const status = tool.state === "running" ? "running" : tool.state === "error" ? "error" : undefined
  const verb =
    tool.state === "running"
      ? "Running"
      : tool.state === "error"
        ? "Failed"
        : tool.state === "denied"
          ? "Denied"
          : "Ran"
  const facts = [
    tool.durationMs === undefined ? null : formatMs(tool.durationMs),
    tool.approval === undefined || tool.approval === "requested" ? null : tool.approval,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={status} data-testid="trace-tool" data-call={tool.callId}>
          <TraceIcon>
            <TerminalIcon />
          </TraceIcon>
          <TraceTitle>
            {verb} {title}
          </TraceTitle>
          {facts && <TraceDescription>{facts}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        <CodeBlock size="sm">
          <CodeBlockContent wrap className="max-h-64">
            {`input: ${tool.input ?? "(not reported)"}\n`}
            {`output: ${tool.summary ?? "(no summary)"}\n`}
            {tool.output ?? ""}
          </CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function roundUsage(round: TraceRound): string {
  if (round.usage === undefined) return ""
  return `${round.usage.inputTokens.toLocaleString("en-US")} in / ${round.usage.outputTokens.toLocaleString("en-US")} out`
}

/** A round as a Task: its line, then its tools and waits. */
function RoundTask({ round }: { round: TraceRound }) {
  const running = round.endedAt === undefined
  const facts = [round.stopReason ?? null, roundUsage(round), span(round.startedAt, round.endedAt)]
    .filter(Boolean)
    .join(" · ")
  const children = [
    ...round.waits.map((wait) => ({ seq: wait.seq, wait })),
    ...round.tools.map((tool) => ({ seq: tool.seq, tool })),
  ].sort((a, b) => a.seq - b.seq)
  return (
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined} data-testid="trace-round">
          <TraceTitle>
            Round {round.turn}
            {round.reasoning ? " (with reasoning)" : ""}
          </TraceTitle>
          <TraceDescription>{facts}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace>
          {children.length === 0 && (
            <TraceLine>
              <TraceTitle>
                {round.textChars > 0 ? `Wrote ${round.textChars} characters` : "No tool calls"}
              </TraceTitle>
            </TraceLine>
          )}
          {children.map((child) =>
            "tool" in child ? (
              <ToolTraceLine key={`tool-${child.tool.callId}`} tool={child.tool} />
            ) : (
              <WaitLine key={`wait-${child.seq}`} wait={child.wait} />
            ),
          )}
          {round.notices.map((notice) => (
            <TraceLine key={notice}>
              <TraceTitle>Notice: {notice}</TraceTitle>
            </TraceLine>
          ))}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function outcomeIcon(run: TraceRun) {
  if (run.outcome === undefined) return <CircleDotIcon />
  if (run.outcome === "completed") return <CircleCheckIcon />
  return <CircleAlertIcon />
}

/** A run as a Chain of Thought: a summary that expands into its rounds. */
function RunChain({ run, open }: { run: TraceRun; open: boolean }) {
  const tools = run.rounds.reduce((sum, round) => sum + round.tools.length, 0)
  const summary = `${run.rounds.length} ${run.rounds.length === 1 ? "round" : "rounds"}, ${tools} ${tools === 1 ? "tool call" : "tool calls"}`
  return (
    <TraceCollapsible defaultOpen={open}>
      <TraceCollapsibleTrigger>
        <TraceLine
          status={
            run.outcome === undefined
              ? "running"
              : run.outcome === "completed"
                ? undefined
                : "error"
          }
          data-testid="trace-run"
          data-outcome={run.outcome ?? "running"}
        >
          <TraceIcon>{outcomeIcon(run)}</TraceIcon>
          <TraceTitle>
            Run {run.index}: {run.userText ?? "(no message)"}
          </TraceTitle>
          <TraceDescription>
            {summary} · {span(run.startedAt, run.endedAt)}
          </TraceDescription>
          <Badge
            variant={
              run.outcome === undefined || run.outcome === "completed" ? "secondary" : "destructive"
            }
          >
            {run.outcome ?? "running"}
          </Badge>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-3 pl-6">
        <Trace>
          {run.waits.map((wait) => (
            <WaitLine key={`wait-${wait.seq}`} wait={wait} />
          ))}
          {run.rounds.map((round) => (
            <RoundTask key={round.seq} round={round} />
          ))}
          {run.error !== undefined && (
            <TraceLine status="error">
              <TraceIcon>
                <CircleAlertIcon />
              </TraceIcon>
              <TraceTitle>Error: {run.error}</TraceTitle>
            </TraceLine>
          )}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** Every run of the session, oldest first. The last one starts open. */
export function Timeline({ runs }: { runs: readonly TraceRun[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet. Send a message in the chat.</p>
  }
  return (
    <Trace>
      {runs.map((run, index) => (
        <RunChain key={run.seq} run={run} open={index === runs.length - 1} />
      ))}
    </Trace>
  )
}
