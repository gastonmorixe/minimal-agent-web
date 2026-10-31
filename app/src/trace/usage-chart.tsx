/**
 * Token usage over time: totals as stat tiles, then input and output tokens
 * per round as two column charts (small multiples, one axis each, because
 * the two measures differ in scale by orders of magnitude), then the same
 * numbers as a table.
 *
 * @module trace/usage-chart
 */

import * as React from "react"

import type { UsagePoint } from "./trace-model.ts"

const WIDTH = 480
const HEIGHT = 140
const PAD = { top: 12, right: 8, bottom: 20, left: 44 }
const MAX_BAR = 24
const RADIUS = 4

/** The smallest 1, 2, 2.5, or 5 times a power of ten that is at least `value`. */
export function niceMax(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power
  return 10 * power
}

/** A tick label: full under 10,000, compact above. */
export function tickLabel(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US")
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`
  return `${Math.round(value / 100_000) / 10}M`
}

/** A column with a 4px rounded top and a square base. */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(RADIUS, width / 2, height)
  const bottom = y + height
  return [
    `M${x},${bottom}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + width - r}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `V${bottom}`,
    "Z",
  ].join(" ")
}

function pointLabel(point: UsagePoint): string {
  return `Run ${point.run}, round ${point.turn}`
}

function ColumnChart({
  title,
  points,
  value,
  testId,
}: {
  title: string
  points: readonly UsagePoint[]
  value: (point: UsagePoint) => number
  testId: string
}) {
  const [hovered, setHovered] = React.useState<number | null>(null)
  const max = niceMax(Math.max(0, ...points.map(value)))
  const plotWidth = WIDTH - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const slot = plotWidth / Math.max(points.length, 1)
  const barWidth = Math.max(2, Math.min(MAX_BAR, slot - 2))
  const y = (v: number) => PAD.top + plotHeight - (v / max) * plotHeight
  const hoveredPoint = hovered === null ? undefined : points[hovered]
  const first = points[0]
  const last = points.at(-1)
  return (
    <figure className="relative flex flex-col gap-1" data-testid={testId}>
      <figcaption className="text-sm font-medium">{title}</figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={title}>
        {[0, max / 2, max].map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {tickLabel(tick)}
            </text>
          </g>
        ))}
        {points.map((point, index) => {
          const v = value(point)
          const top = y(v)
          const x = PAD.left + index * slot + (slot - barWidth) / 2
          return (
            <g key={point.seq}>
              <path
                d={columnPath(x, top, barWidth, PAD.top + plotHeight - top)}
                fill="var(--chart-2)"
                opacity={hovered === null || hovered === index ? 1 : 0.5}
              />
              <rect
                x={PAD.left + index * slot}
                y={PAD.top}
                width={slot}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(null)}
              >
                <title>{`${pointLabel(point)}: ${v.toLocaleString("en-US")}`}</title>
              </rect>
            </g>
          )
        })}
        {first !== undefined && (
          <>
            <text x={PAD.left} y={HEIGHT - 4} className="fill-muted-foreground text-[10px]">
              {pointLabel(first)}
            </text>
            {points.length > 1 && (
              <text
                x={WIDTH - PAD.right}
                y={HEIGHT - 4}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {last === undefined ? "" : pointLabel(last)}
              </text>
            )}
          </>
        )}
      </svg>
      {hoveredPoint !== undefined && (
        <div
          className="pointer-events-none absolute top-6 right-2 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
          role="status"
        >
          {pointLabel(hoveredPoint)}: {value(hoveredPoint).toLocaleString("en-US")} tokens
        </div>
      )}
    </figure>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value.toLocaleString("en-US")}</span>
    </div>
  )
}

/** The usage section of the trace view. */
export function UsageView({ points }: { points: readonly UsagePoint[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-muted-foreground">No completed rounds yet.</p>
  }
  const last = points.at(-1)
  const cacheRead = points.reduce((sum, point) => sum + point.cacheReadTokens, 0)
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Rounds" value={points.length} />
        <Stat label="Input tokens" value={last?.totalInput ?? 0} />
        <Stat label="Output tokens" value={last?.totalOutput ?? 0} />
        <Stat label="Cache read tokens" value={cacheRead} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ColumnChart
          title="Input tokens per round"
          points={points}
          value={(point) => point.inputTokens}
          testId="usage-input"
        />
        <ColumnChart
          title="Output tokens per round"
          points={points}
          value={(point) => point.outputTokens}
          testId="usage-output"
        />
      </div>
      <table className="w-full text-sm" data-testid="usage-table">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="font-normal">Run</th>
            <th className="font-normal">Round</th>
            <th className="text-right font-normal">Input</th>
            <th className="text-right font-normal">Cache read</th>
            <th className="text-right font-normal">Output</th>
            <th className="text-right font-normal">Input so far</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {points.map((point) => (
            <tr key={point.seq} className="border-t">
              <td>{point.run}</td>
              <td>{point.turn}</td>
              <td className="text-right">{point.inputTokens.toLocaleString("en-US")}</td>
              <td className="text-right">{point.cacheReadTokens.toLocaleString("en-US")}</td>
              <td className="text-right">{point.outputTokens.toLocaleString("en-US")}</td>
              <td className="text-right">{point.totalInput.toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
