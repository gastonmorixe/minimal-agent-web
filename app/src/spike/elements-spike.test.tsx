import { expect, test } from "bun:test"

import { renderToString } from "react-dom/server"
import { TooltipProvider } from "@/components/ui/tooltip"

import { ElementsSpike, SPIKE_ELEMENTS } from "./elements-spike.tsx"

/** The AI Elements named in spec section 4.4, in its order. */
const SPEC_ELEMENTS = [
  "Conversation",
  "Message",
  "Prompt Input",
  "Reasoning",
  "Tool",
  "Chain of Thought",
  "Task",
  "Plan",
  "Queue",
  "Context",
  "Confirmation",
  "Code Block",
  "Shimmer",
]

test("the spike covers every AI Element named in spec 4.4", () => {
  expect(SPIKE_ELEMENTS.map((element) => element.name)).toEqual(SPEC_ELEMENTS)
})

test("every spike section renders", () => {
  const html = renderToString(
    <TooltipProvider>
      <ElementsSpike />
    </TooltipProvider>,
  )
  for (const name of SPEC_ELEMENTS) expect(html).toContain(`data-element="${name}"`)
  expect(html).toContain('data-slot="message-scroller"')
  expect(html).toContain('data-slot="code-block-content"')
  expect(html).toContain("shimmer")
})
