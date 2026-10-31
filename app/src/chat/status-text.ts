/**
 * Labels for core status phase codes. Core sends codes only (spec 3.2 of v1);
 * the frontend owns the words. Unknown codes show as they are.
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
    case "connect":
      return "Connecting"
    case "upload":
      return "Sending the request"
    case "wait-headers":
      return "Waiting for the model"
    case "stream":
    case "writing":
      return "Writing"
    case "thinking":
      return "Thinking"
    case "tool-input":
    case "tool-dispatch":
    case "tool-run":
      return status.toolName === undefined ? "Running a tool" : `Running ${status.toolName}`
    case "auth-refresh":
      return "Refreshing the credential"
    default:
      return status.phase
  }
}
