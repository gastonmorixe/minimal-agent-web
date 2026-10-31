/**
 * The trace view (spec 4.4, S56), built from the native event log, not the
 * chat stream. It shows the timeline, the diagnostics, and token usage. It
 * survives a reload: the new page subscribes without a seq, the server
 * replays the log from seq 0, and the same model is folded again.
 *
 * @module trace/trace-view
 */

import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { EventLogView } from "@/session/use-event-log.ts"

import { Diagnostics } from "./diagnostics.tsx"
import { Timeline } from "./timeline.tsx"
import { buildTrace } from "./trace-model.ts"
import { UsageView } from "./usage-chart.tsx"

/** The trace of one session. */
export function TraceView({ log }: { log: EventLogView }) {
  const model = React.useMemo(() => buildTrace(log.entries), [log.entries])
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant={log.state === "live" ? "secondary" : "outline"} data-testid="trace-state">
          {log.state}
        </Badge>
        <span
          data-testid="trace-count"
          data-entries={log.entries.length}
          data-last-seq={model.lastSeq}
        >
          {log.entries.length} entries, last seq {model.lastSeq}
        </span>
      </div>
      <Tabs defaultValue="timeline" className="flex flex-col gap-4">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="diagnostics">Diagnostics ({model.diagnostics.length})</TabsTrigger>
          <TabsTrigger value="usage">Token usage</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <Timeline runs={model.runs} />
        </TabsContent>
        <TabsContent value="diagnostics">
          <Diagnostics diagnostics={model.diagnostics} />
        </TabsContent>
        <TabsContent value="usage">
          <UsageView points={model.usage} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
