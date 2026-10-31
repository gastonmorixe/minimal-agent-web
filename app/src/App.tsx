import { TooltipProvider } from "@/components/ui/tooltip"

import { ElementsSpike } from "./spike/elements-spike.tsx"

/** The app root. Until the chat UI lands (S55), it shows the build spike. */
export function App() {
  return (
    <TooltipProvider>
      <ElementsSpike />
    </TooltipProvider>
  )
}
