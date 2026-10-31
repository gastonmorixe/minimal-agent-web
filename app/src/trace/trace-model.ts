/**
 * The trace view's model, folded from the session event log (spec 4.4).
 *
 * {@link buildTrace} is pure: entries in, model out. The view keeps every
 * entry it received and folds them again when one arrives, so a reload that
 * replays the log from seq 0 builds the same model.
 *
 * - A run starts at `user_message` (or the first event after the previous
 *   run) and ends at `run_finished`.
 * - A round is one model response: `turn_started` to `turn_completed`.
 * - A tool call opens at its `tool_use` item or `tool_call`, collects
 *   `tool_output`, and ends at `tool_result`. Its duration is the
 *   `durationMs` core reports, else the time between those entries.
 * - Waits: `status` with `retrying`, `waiting_for_quota`, or
 *   `waiting_for_host`, `quota`, and `ask_user` (core's preflight ask, a
 *   plain multiple-choice question, never a tool approval: core has no
 *   tool-approval concept, so a tool call never links to an ask). There is
 *   no event for an answer, so an `ask` wait always shows as asked, never
 *   as answered — same as the chat (spec 4.3's `data-ask-user`).
 * - Diagnostics and token usage are lists in seq order.
 *
 * Unknown event kinds and fields are ignored: core adds kinds over time.
 *
 * @module trace/trace-model
 */

import type { DiagnosticData, EventData, SessionEntry, TurnUsage } from "@/api/types.ts"

/** One tool call. */
export interface TraceTool {
  callId: string
  toolName: string
  seq: number
  startedAt: number
  input?: string
  /** Text from `tool_output` events. */
  output?: string
  /** `tool_result.outputSummary`. */
  summary?: string
  durationMs?: number
  state: "running" | "done" | "error"
}

/** A wait: a retry, a quota wait, a wait for the host, or a preflight ask. */
export interface TraceWait {
  seq: number
  ts: number
  kind: "retry" | "quota" | "host" | "ask"
  attempt?: number
  nextDelayMs?: number
  cause?: string
  resetAt?: number
  provider?: string
  used?: number
  limit?: number
  /** `ask_user.title`. */
  title?: string
}

/** One round: a model response and the tools it ran. */
export interface TraceRound {
  turn: number
  seq: number
  startedAt: number
  endedAt?: number
  stopReason?: string | null
  usage?: TurnUsage
  tools: TraceTool[]
  waits: TraceWait[]
  reasoning: boolean
  textChars: number
  notices: string[]
}

/** One run: from the person's message to `run_finished`. */
export interface TraceRun {
  /** 1-based position in the session. */
  index: number
  seq: number
  startedAt: number
  endedAt?: number
  userText?: string
  outcome?: string
  error?: string
  rounds: TraceRound[]
  /** Waits outside any round. */
  waits: TraceWait[]
}

/** One diagnostic, with its place in the log. */
export interface TraceDiagnostic extends DiagnosticData {
  seq: number
  ts: number
}

/** Token usage of one round, and the session totals so far. */
export interface UsagePoint {
  seq: number
  ts: number
  run: number
  turn: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalInput: number
  totalOutput: number
}

/** The whole model. */
export interface TraceModel {
  runs: TraceRun[]
  diagnostics: TraceDiagnostic[]
  usage: UsagePoint[]
  /** Highest seq seen, or -1. */
  lastSeq: number
}

function str(data: EventData, key: string): string | undefined {
  const value = data[key]
  return typeof value === "string" ? value : undefined
}

function num(data: EventData, key: string): number | undefined {
  const value = data[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function usageOf(data: EventData): TurnUsage | undefined {
  const value = data.usage
  if (typeof value !== "object" || value === null) return undefined
  const usage: EventData = { type: "usage", ...value }
  const inputTokens = num(usage, "inputTokens")
  const outputTokens = num(usage, "outputTokens")
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = num(usage, "cacheReadTokens")
  const cacheCreationTokens = num(usage, "cacheCreationTokens")
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
  }
}

/** Mutable fold state. */
class Folder {
  readonly model: TraceModel = { runs: [], diagnostics: [], usage: [], lastSeq: -1 }
  private run: TraceRun | null = null
  private round: TraceRound | null = null
  private readonly tools = new Map<string, TraceTool>()
  private totalInput = 0
  private totalOutput = 0

  add(entry: SessionEntry): void {
    this.model.lastSeq = Math.max(this.model.lastSeq, entry.seq)
    if (entry.ch === "diag") {
      this.model.diagnostics.push({ ...entry.data, seq: entry.seq, ts: entry.ts })
      return
    }
    this.event(entry.seq, entry.ts, entry.data)
  }

  private openRun(seq: number, ts: number, userText?: string): TraceRun {
    this.round = null
    this.tools.clear()
    const run: TraceRun = {
      index: this.model.runs.length + 1,
      seq,
      startedAt: ts,
      rounds: [],
      waits: [],
      ...(userText === undefined ? {} : { userText }),
    }
    this.model.runs.push(run)
    this.run = run
    return run
  }

  private currentRun(seq: number, ts: number): TraceRun {
    return this.run ?? this.openRun(seq, ts)
  }

  private addWait(seq: number, ts: number, wait: TraceWait): void {
    const target = this.round ?? this.currentRun(seq, ts)
    target.waits.push(wait)
  }

  private tool(seq: number, ts: number, callId: string, toolName: string): TraceTool {
    const known = this.tools.get(callId)
    if (known !== undefined) {
      if (toolName.length > 0) known.toolName = toolName
      return known
    }
    const tool: TraceTool = { callId, toolName, seq, startedAt: ts, state: "running" }
    this.tools.set(callId, tool)
    const round = this.round ?? this.currentRun(seq, ts).rounds.at(-1)
    round?.tools.push(tool)
    return tool
  }

  private event(seq: number, ts: number, data: EventData): void {
    switch (data.type) {
      case "user_message":
        this.openRun(seq, ts, str(data, "text"))
        return
      case "turn_started": {
        const round: TraceRound = {
          turn: num(data, "turn") ?? 0,
          seq,
          startedAt: ts,
          tools: [],
          waits: [],
          reasoning: false,
          textChars: 0,
          notices: [],
        }
        this.currentRun(seq, ts).rounds.push(round)
        this.round = round
        return
      }
      case "turn_completed":
        this.completeRound(seq, ts, data)
        return
      case "text_delta":
        if (this.round !== null) this.round.textChars += str(data, "text")?.length ?? 0
        return
      case "thinking_delta":
        if (this.round !== null) this.round.reasoning = true
        return
      case "item_completed":
        this.itemCompleted(seq, ts, data)
        return
      case "tool_call": {
        const tool = this.tool(seq, ts, str(data, "callId") ?? "", str(data, "toolName") ?? "")
        tool.startedAt = ts
        const input = str(data, "inputSummary")
        if (input !== undefined) tool.input = input
        return
      }
      case "tool_output": {
        const tool = this.tool(seq, ts, str(data, "callId") ?? "", str(data, "toolName") ?? "")
        tool.output = (tool.output ?? "") + (str(data, "text") ?? "")
        return
      }
      case "tool_result":
        this.toolResult(seq, ts, data)
        return
      case "status":
        this.status(seq, ts, data)
        return
      case "quota":
        this.addWait(seq, ts, waitFrom(seq, ts, "quota", data))
        return
      case "ask_user":
        this.askUser(seq, ts, data)
        return
      case "notice": {
        const notice = data.notice
        const kind =
          typeof notice === "object" && notice !== null && "kind" in notice
            ? String(notice.kind)
            : "notice"
        this.round?.notices.push(kind)
        return
      }
      case "error":
        this.currentRun(seq, ts).error = str(data, "message") ?? "error"
        return
      case "run_finished": {
        const run = this.currentRun(seq, ts)
        run.endedAt = ts
        run.outcome = str(data, "outcome") ?? "completed"
        this.run = null
        this.round = null
        return
      }
      default:
        return
    }
  }

  private completeRound(seq: number, ts: number, data: EventData): void {
    const round = this.round
    if (round === null) return
    round.endedAt = ts
    const stopReason = data.stopReason
    round.stopReason = typeof stopReason === "string" ? stopReason : null
    const usage = usageOf(data)
    if (usage !== undefined) {
      round.usage = usage
      this.totalInput += usage.inputTokens
      this.totalOutput += usage.outputTokens
      this.model.usage.push({
        seq,
        ts,
        run: this.run?.index ?? 0,
        turn: round.turn,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        totalInput: this.totalInput,
        totalOutput: this.totalOutput,
      })
    }
    this.round = null
  }

  private itemCompleted(seq: number, ts: number, data: EventData): void {
    const itemType = str(data, "itemType")
    if (itemType === "tool_use") this.tool(seq, ts, str(data, "id") ?? "", str(data, "text") ?? "")
    else if (itemType === "thinking" && this.round !== null) this.round.reasoning = true
    else if (itemType === "text" && this.round !== null && this.round.textChars === 0) {
      this.round.textChars = str(data, "text")?.length ?? 0
    }
  }

  private toolResult(seq: number, ts: number, data: EventData): void {
    const tool = this.tool(seq, ts, str(data, "id") ?? "", str(data, "name") ?? "")
    const summary = str(data, "outputSummary")
    const input = str(data, "inputSummary")
    if (summary !== undefined) tool.summary = summary
    if (input !== undefined && tool.input === undefined) tool.input = input
    tool.durationMs = num(data, "durationMs") ?? ts - tool.startedAt
    tool.state = data.isError === true ? "error" : "done"
  }

  private status(seq: number, ts: number, data: EventData): void {
    const phase = str(data, "phase")
    const kind =
      phase === "retrying"
        ? "retry"
        : phase === "waiting_for_quota"
          ? "quota"
          : phase === "waiting_for_host"
            ? "host"
            : null
    if (kind !== null) this.addWait(seq, ts, waitFrom(seq, ts, kind, data))
  }

  private askUser(seq: number, ts: number, data: EventData): void {
    this.addWait(seq, ts, { seq, ts, kind: "ask", title: str(data, "title") ?? "" })
  }
}

/** A wait with the fields of `data` that are present. */
function waitFrom(seq: number, ts: number, kind: TraceWait["kind"], data: EventData): TraceWait {
  const wait: TraceWait = { seq, ts, kind }
  for (const key of ["attempt", "nextDelayMs", "resetAt", "used", "limit"] as const) {
    const value = num(data, key)
    if (value !== undefined) wait[key] = value
  }
  for (const key of ["cause", "provider"] as const) {
    const value = str(data, key)
    if (value !== undefined) wait[key] = value
  }
  return wait
}

/** Fold a session's entries (in seq order) into the trace model. */
export function buildTrace(entries: Iterable<SessionEntry>): TraceModel {
  const folder = new Folder()
  for (const entry of entries) folder.add(entry)
  return folder.model
}
