/**
 * Labels for core status phase codes (`sending`, `receiving`, `running_tool`,
 * `retrying`, `waiting_for_quota`, `waiting_for_host`). Core sends codes
 * only (`@minimal-agent/core/sdk/events`'s `StatusPhase`); the frontend owns
 * the words. Unknown codes show as they are, so a new phase still renders.
 *
 * @module chat/status-text
 */

import type { StatusData } from "@/api/types.ts"

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`
}

/** One line for a status part. */
export function statusText(status: StatusData): string {
  switch (status.phase) {
    case "sending":
      return "Sending the request"
    case "receiving":
      return "Writing"
    case "running_tool":
      return status.toolName === undefined ? "Running a tool" : `Running ${status.toolName}`
    case "retrying": {
      const wait = status.nextDelayMs === undefined ? "" : ` in ${seconds(status.nextDelayMs)}`
      const cause = status.cause === undefined ? "" : ` (${status.cause})`
      return `Retrying${wait}, attempt ${(status.attempt ?? 0) + 1}${cause}`
    }
    case "waiting_for_quota":
      return status.resetAt === undefined
        ? "Waiting for the quota to reset"
        : `Waiting for the quota to reset at ${new Date(status.resetAt).toLocaleTimeString()}`
    case "waiting_for_host":
      return "Paused: waiting for the host"
    default:
      return status.phase
  }
}
