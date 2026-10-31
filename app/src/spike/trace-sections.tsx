/**
 * Build spike (S52): the AI Elements patterns that are built on Trace.
 *
 * Each section follows the "Usage" code of its pattern page at
 * ui.shadcn.com/docs/ai-elements/radix/<name>, with static sample data. The
 * components come from the shadcn/ui registry
 * (`shadcn add trace code-block badge`). The real chat UI that maps message
 * parts onto these patterns is S55.
 */

import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  FileTextIcon,
  ListChecksIcon,
  ListTodoIcon,
  RouteIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react"
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

/** Reasoning: the agent's thinking, as one collapsible trace line. */
export function ReasoningSection() {
  return (
    <Trace>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <CircleCheckIcon />
            </TraceIcon>
            <TraceTitle>Thought</TraceTitle>
            <TraceDescription>4s</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="whitespace-pre-wrap">
          The session store already keeps one JSONL file per session, so the web server can reuse
          it.
        </TraceCollapsibleContent>
      </TraceCollapsible>
      <TraceLine status="running">
        <TraceIcon>
          <CircleDotIcon />
        </TraceIcon>
        <TraceTitle>Thinking</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

/** Tool: a tool call from input to output, with the output in a small code block. */
export function ToolSection() {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <TerminalIcon />
            </TraceIcon>
            <TraceTitle>Ran git status --short</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm">
            <CodeBlockContent wrap className="max-h-64">
              {" M server/src/main.ts\n M app/src/App.tsx"}
            </CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status="error">
            <TraceIcon>
              <TerminalIcon />
            </TraceIcon>
            <TraceTitle>Failed to run bun test</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <CodeBlock size="sm">
            <CodeBlockContent wrap className="max-h-64">
              1 test failed.
            </CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
      <TraceLine status="running">
        <TraceIcon>
          <TerminalIcon />
        </TraceIcon>
        <TraceTitle>Running bun run check</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

/** Chain of Thought: a summary that expands into the steps the agent took. */
export function ChainOfThoughtSection() {
  return (
    <Trace>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <CircleCheckIcon />
            </TraceIcon>
            <TraceTitle>Researched in 3 steps</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-3">
          <Trace>
            <TraceLine>
              <TraceIcon>
                <CircleCheckIcon />
              </TraceIcon>
              <TraceTitle>Read the core event types</TraceTitle>
              <Badge variant="secondary">sdk/events</Badge>
            </TraceLine>
            <TraceLine>
              <TraceIcon>
                <CircleCheckIcon />
              </TraceIcon>
              <TraceTitle>Searched the code for turn_completed</TraceTitle>
            </TraceLine>
            <TraceLine>
              <TraceIcon>
                <CircleCheckIcon />
              </TraceIcon>
              <TraceTitle>Compared it with the UI message stream</TraceTitle>
            </TraceLine>
          </Trace>
          <CodeBlock size="sm">
            <CodeBlockContent>{'{ "type": "finish-step" }'}</CodeBlockContent>
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

/** Task: the steps the agent takes for one task, nested under the task line. */
export function TaskSection() {
  return (
    <Trace>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>Found the project files</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            <TraceLine>
              <TraceIcon>
                <SearchIcon />
              </TraceIcon>
              <TraceTitle>Searched for server/src/main.ts</TraceTitle>
            </TraceLine>
            <TraceLine>
              <TraceIcon>
                <FileTextIcon />
              </TraceIcon>
              <TraceTitle>Read server/src/main.ts</TraceTitle>
            </TraceLine>
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
      <TraceLine status="running">
        <TraceTitle>Updating the chat stream adapter</TraceTitle>
      </TraceLine>
    </Trace>
  )
}

/** Plan: the planned steps and how far the agent has got. */
export function PlanSection() {
  return (
    <Trace>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine status="running">
            <TraceIcon>
              <RouteIcon />
            </TraceIcon>
            <TraceTitle>Plan: serve the chat stream</TraceTitle>
            <TraceDescription>1 of 3 done</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            <TraceLine>
              <TraceIcon>
                <CircleCheckIcon />
              </TraceIcon>
              <TraceTitle>Map core events to stream parts</TraceTitle>
            </TraceLine>
            <TraceLine status="running">
              <TraceIcon>
                <CircleDotIcon />
              </TraceIcon>
              <TraceTitle>Add the messages route</TraceTitle>
            </TraceLine>
            <TraceLine status="pending">
              <TraceIcon>
                <CircleIcon />
              </TraceIcon>
              <TraceTitle>Render the parts with useChat</TraceTitle>
            </TraceLine>
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

/** Queue: the agent's todo list, split into what is left and what is done. */
export function QueueSection() {
  return (
    <Trace>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <ListTodoIcon />
            </TraceIcon>
            <TraceTitle>2 to do</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            <TraceLine>
              <TraceIcon>
                <CircleIcon />
              </TraceIcon>
              <TraceTitle>Add the trace view</TraceTitle>
            </TraceLine>
            <TraceLine>
              <TraceIcon>
                <CircleIcon />
              </TraceIcon>
              <TraceTitle>Add the Playwright suite</TraceTitle>
            </TraceLine>
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <ListChecksIcon />
            </TraceIcon>
            <TraceTitle>1 completed</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            <TraceLine>
              <TraceIcon>
                <CircleCheckIcon />
              </TraceIcon>
              <TraceTitle>Bootstrap the web repo</TraceTitle>
            </TraceLine>
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}
