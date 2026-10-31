/**
 * Context (spec 4.4): how much of the model's context window the last round
 * used. Built on the Context pattern (`/docs/ai-elements/radix/context`): a
 * Hover Card with a Progress bar. The numbers come from the `data-usage`
 * parts of the chat stream; the window size comes from the session.
 *
 * @module chat/context-meter
 */

import type { ChatMessage, TurnUsage } from "@/api/types.ts"
import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"

/** The usage of the last completed round in the conversation, if any. */
export function lastTurnUsage(messages: readonly ChatMessage[]): TurnUsage | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m]?.parts ?? []
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p]
      if (part?.type === "data-usage" && part.data.kind === "turn") return part.data.usage
    }
  }
  return null
}

/** Tokens in the context after a round: everything sent plus what came back. */
export function contextTokens(usage: TurnUsage): number {
  return (
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0) +
    usage.outputTokens
  )
}

const count = (value: number) => value.toLocaleString("en-US")

/** The Context element for a conversation. */
export function ContextMeter({
  messages,
  limit,
}: {
  messages: readonly ChatMessage[]
  limit: number
}) {
  const usage = lastTurnUsage(messages)
  const used = usage === null ? 0 : contextTokens(usage)
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <HoverCard openDelay={10} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button variant="outline" size="sm" data-testid="context">
          {percent}% context
        </Button>
      </HoverCardTrigger>
      <HoverCardContent className="flex w-64 flex-col gap-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">Context</span>
          <span className="text-muted-foreground">
            {count(used)} / {count(limit)}
          </span>
        </div>
        <Progress value={percent} aria-label="Context used" />
        {usage !== null && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <dt>Input</dt>
            <dd className="text-right tabular-nums">{count(usage.inputTokens)}</dd>
            <dt>Cache read</dt>
            <dd className="text-right tabular-nums">{count(usage.cacheReadTokens ?? 0)}</dd>
            <dt>Cache write</dt>
            <dd className="text-right tabular-nums">{count(usage.cacheCreationTokens ?? 0)}</dd>
            <dt>Output</dt>
            <dd className="text-right tabular-nums">{count(usage.outputTokens)}</dd>
          </dl>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}
