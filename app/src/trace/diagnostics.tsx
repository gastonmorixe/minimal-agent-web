/**
 * Diagnostics from the event log (`ch: "diag"`), with a severity filter.
 *
 * Severities are RFC 5424: a lower number is more severe. The filter shows a
 * severity and everything more severe, as core's `minSeverity` does.
 *
 * @module trace/diagnostics
 */

import * as React from "react"
import { SEVERITIES, type SeverityName } from "@/api/types.ts"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import type { TraceDiagnostic } from "./trace-model.ts"

/** The name of an RFC 5424 severity number. */
export function severityName(severity: number): SeverityName | `severity ${number}` {
  return SEVERITIES[severity] ?? `severity ${severity}`
}

/** The diagnostics at `min` or more severe. */
export function filterDiagnostics(
  diagnostics: readonly TraceDiagnostic[],
  min: number,
): TraceDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.severity <= min)
}

function badgeVariant(severity: number): "destructive" | "secondary" | "outline" {
  if (severity <= 3) return "destructive"
  if (severity <= 5) return "secondary"
  return "outline"
}

/** The diagnostics list with its filter. */
export function Diagnostics({ diagnostics }: { diagnostics: readonly TraceDiagnostic[] }) {
  const [min, setMin] = React.useState(7)
  const shown = filterDiagnostics(diagnostics, min)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground" id="severity-label">
          Show
        </span>
        <Select value={String(min)} onValueChange={(value) => setMin(Number(value))}>
          <SelectTrigger
            size="sm"
            className="w-44"
            aria-labelledby="severity-label"
            data-testid="severity-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEVERITIES.map((name, severity) => (
              <SelectItem key={name} value={String(severity)}>
                {severity === 0 ? name : `${name} and worse`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground" data-testid="diagnostic-count">
          {shown.length} of {diagnostics.length}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No diagnostics at this level.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border text-sm">
          {shown.map((diagnostic) => (
            <li
              key={diagnostic.seq}
              className="flex flex-col gap-1 px-3 py-2"
              data-testid="diagnostic"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={badgeVariant(diagnostic.severity)}>
                  {severityName(diagnostic.severity)}
                </Badge>
                <span className="font-mono text-xs">{diagnostic.code}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  #{diagnostic.seq} · {new Date(diagnostic.ts).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-muted-foreground">{diagnostic.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
