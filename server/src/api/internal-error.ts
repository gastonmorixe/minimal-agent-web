/**
 * Internal errors: an error that no route maps to a status.
 *
 * The client gets a generic answer with a request id. It never gets the
 * message, the stack, or a file path. The server log (stderr) gets the
 * full error with the same request id, so an operator can match the two.
 *
 * @module api/internal-error
 */

/** The `error` text a client sees for every internal error. */
export const INTERNAL_ERROR = "internal error"

/**
 * Log an internal error to stderr with a new request id, and return that id.
 * `where` names the place that failed (for example a method and a path).
 */
export function logInternalError(error: unknown, where: string): string {
  const requestId = crypto.randomUUID()
  const detail =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
  console.error(`minimal-agent web: internal error ${requestId} in ${where}: ${detail}`)
  return requestId
}

/** The 500 answer for an internal error: JSON, with no detail. */
export function internalErrorResponse(requestId: string): Response {
  return Response.json(
    { error: INTERNAL_ERROR, requestId },
    { status: 500, headers: { "cache-control": "no-store" } },
  )
}
