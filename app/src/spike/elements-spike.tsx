/**
 * Build spike (S52, decision D22): one page that renders every AI Elements
 * pattern named in spec section 4.4, so `vite build` proves they build under
 * Vite. The patterns come from the shadcn/ui registry (D23).
 */

import type * as React from "react"

import {
  CodeBlockSection,
  ConfirmationSection,
  ContextSection,
  ConversationSection,
  MessageSection,
  PromptInputSection,
  ShimmerSection,
} from "./chat-sections.tsx"
import {
  ChainOfThoughtSection,
  PlanSection,
  QueueSection,
  ReasoningSection,
  TaskSection,
  ToolSection,
} from "./trace-sections.tsx"

/** One spike section: the element name from spec 4.4 and its rendering. */
export interface SpikeElement {
  name: string
  /** The shadcn/ui docs page the section follows. */
  docs: string
  Section: () => React.ReactNode
}

const PATTERNS = "https://ui.shadcn.com/docs/ai-elements/radix"

/** The AI Elements named in spec 4.4, in that order. */
export const SPIKE_ELEMENTS: readonly SpikeElement[] = [
  { name: "Conversation", docs: `${PATTERNS}/chat`, Section: ConversationSection },
  { name: "Message", docs: `${PATTERNS}/message`, Section: MessageSection },
  { name: "Prompt Input", docs: `${PATTERNS}/prompt-input`, Section: PromptInputSection },
  { name: "Reasoning", docs: `${PATTERNS}/reasoning`, Section: ReasoningSection },
  { name: "Tool", docs: `${PATTERNS}/tool`, Section: ToolSection },
  {
    name: "Chain of Thought",
    docs: `${PATTERNS}/chain-of-thought`,
    Section: ChainOfThoughtSection,
  },
  { name: "Task", docs: `${PATTERNS}/task`, Section: TaskSection },
  { name: "Plan", docs: `${PATTERNS}/plan`, Section: PlanSection },
  { name: "Queue", docs: `${PATTERNS}/queue`, Section: QueueSection },
  { name: "Context", docs: `${PATTERNS}/context`, Section: ContextSection },
  { name: "Confirmation", docs: `${PATTERNS}/confirmation`, Section: ConfirmationSection },
  {
    name: "Code Block",
    docs: "https://ui.shadcn.com/docs/components/radix/code-block",
    Section: CodeBlockSection,
  },
  { name: "Shimmer", docs: "https://ui.shadcn.com/docs/utils/shimmer", Section: ShimmerSection },
]

/** The spike page: every element in its own labeled section. */
export function ElementsSpike() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-10 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">minimal-agent web: AI Elements build spike</h1>
        <p className="text-sm text-muted-foreground">
          Every element from spec 4.4, built with Vite from the shadcn/ui registry.
        </p>
      </header>
      {SPIKE_ELEMENTS.map(({ name, docs, Section }) => (
        <section key={name} data-element={name} className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">
            <a href={docs} className="hover:underline">
              {name}
            </a>
          </h2>
          <Section />
        </section>
      ))}
    </main>
  )
}
