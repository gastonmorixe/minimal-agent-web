/**
 * Calls to the session API (spec 4.2). Every call sends the bearer token in
 * the `Authorization` header. A 401 means the server restarted with a new
 * token: the client forgets the token and tells the app, which then asks the
 * person to open the URL the server printed.
 *
 * @module api/client
 */

import { clearToken, getToken } from "./token.ts"
import type {
  AskAnswer,
  HistoryMessage,
  SessionDetail,
  SessionList,
  SessionSummary,
} from "./types.ts"

/** The server refused the token. */
export class UnauthorizedError extends Error {
  /** Create the error. */
  constructor() {
    super("The server refused the API token. Open the URL the server printed at start.")
    this.name = "UnauthorizedError"
  }
}

/** An API call failed. */
export class ApiError extends Error {
  readonly status: number

  /** Create the error. */
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

const unauthorizedListeners = new Set<() => void>()

/** Call `listener` when the server refuses the token. Returns the unsubscribe. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

/** Forget the token and tell the app. */
export function reportUnauthorized(): void {
  clearToken()
  for (const listener of unauthorizedListeners) listener()
}

/** The `Authorization` header for API calls. */
export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token === null ? {} : { authorization: `Bearer ${token}` }
}

/**
 * `fetch` with the token. A 401 throws {@link UnauthorizedError}. The chat
 * transport uses it too.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value)
  const response = await fetch(input, { ...init, headers })
  if (response.status === 401) {
    reportUnauthorized()
    throw new UnauthorizedError()
  }
  return response
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSummary(value: unknown): value is SessionSummary {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string"
}

function isHistoryMessage(value: unknown): value is HistoryMessage {
  if (!isRecord(value) || typeof value.id !== "string") return false
  if (value.role === "user") return typeof value.text === "string"
  return value.role === "assistant" && Array.isArray(value.chunks)
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : response.statusText
    throw new ApiError(response.status, message)
  }
  if (!isRecord(body)) throw new ApiError(response.status, "the server sent no JSON object")
  return body
}

async function send(path: string, body: unknown): Promise<Record<string, unknown>> {
  return readJson(
    await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

/** `GET /api/sessions`. */
export async function listSessions(): Promise<SessionList> {
  const body = await readJson(await apiFetch("/api/sessions"))
  const sessions = Array.isArray(body.sessions) ? body.sessions.filter(isSummary) : []
  return { backend: body.backend === "core" ? "core" : "fake", sessions }
}

/** `POST /api/sessions`. */
export async function createSession(): Promise<SessionSummary> {
  const body = await send("/api/sessions", {})
  if (!isSummary(body.session)) throw new ApiError(500, "the server sent no session")
  return body.session
}

/** `GET /api/sessions/:id`, or null when the session does not exist. */
export async function getSession(id: string): Promise<SessionDetail | null> {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`)
  if (response.status === 404) return null
  const body = await readJson(response)
  if (!isSummary(body.session)) throw new ApiError(500, "the server sent no session")
  const history = Array.isArray(body.history) ? body.history.filter(isHistoryMessage) : []
  return { backend: body.backend === "core" ? "core" : "fake", session: body.session, history }
}

/** `POST /api/sessions/:id/answers`. */
export async function answerAsk(id: string, askId: string, answer: AskAnswer): Promise<void> {
  await send(`/api/sessions/${encodeURIComponent(id)}/answers`, { askId, answer })
}

/** `POST /api/sessions/:id/abort`. True when a turn was running. */
export async function abortTurn(id: string): Promise<boolean> {
  const body = await send(`/api/sessions/${encodeURIComponent(id)}/abort`, {})
  return body.aborted === true
}
