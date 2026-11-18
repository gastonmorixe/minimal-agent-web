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
  CreateSessionInput,
  CredentialInfo,
  HistoryMessage,
  ModelList,
  ModelRow,
  SessionDetail,
  SessionList,
  SessionSummary,
  SetTargetInput,
  TransportInfo,
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

const FALLBACK_TRANSPORT: TransportInfo = { kind: "scripted", description: "unknown transport" }

function isTransport(value: unknown): value is TransportInfo {
  if (!isRecord(value) || typeof value.description !== "string") return false
  if (value.kind === "scripted") return true
  return value.kind === "provider" && typeof value.providerId === "string"
}

/** True for a well-formed credential entry. */
export function isCredential(value: unknown): value is CredentialInfo {
  return (
    isRecord(value) &&
    typeof value.providerId === "string" &&
    typeof value.displayName === "string" &&
    (value.authKind === "oauth" || value.authKind === "api-key") &&
    typeof value.credentialName === "string" &&
    typeof value.credentialLabel === "string" &&
    typeof value.usable === "boolean"
  )
}

/**
 * One model row of `GET /api/models`, or null for a value that is not one.
 * The effort levels come from `capabilities.effort.levels`. A row with no
 * levels there (an older server) is kept, with no effort levels.
 */
export function modelRowFrom(value: unknown): ModelRow | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.contextWindow !== "number"
  ) {
    return null
  }
  const effort = isRecord(value.capabilities) ? value.capabilities.effort : undefined
  const levels = isRecord(effort) && Array.isArray(effort.levels) ? effort.levels : []
  return {
    id: value.id,
    providerId: value.providerId,
    displayName: value.displayName,
    contextWindow: value.contextWindow,
    effortLevels: levels.filter((level): level is string => typeof level === "string"),
  }
}

function transportOf(body: Record<string, unknown>): TransportInfo {
  return isTransport(body.transport) ? body.transport : FALLBACK_TRANSPORT
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
  return { backend: "core", transport: transportOf(body), sessions }
}

/** `GET /api/models`: the booted models, the usable credentials, and the deprecated default model id. */
export async function listModels(): Promise<ModelList> {
  const body = await readJson(await apiFetch("/api/models"))
  const models = Array.isArray(body.models)
    ? body.models.map(modelRowFrom).filter((row): row is ModelRow => row !== null)
    : []
  const credentials = Array.isArray(body.credentials) ? body.credentials.filter(isCredential) : []
  const defaultModelId = typeof body.defaultModelId === "string" ? body.defaultModelId : ""
  return { models, credentials, defaultModelId }
}

/**
 * `POST /api/sessions`. `model` is required in provider mode, omitted in
 * scripted mode. `providerId` and `credentialName` pick the credential.
 * `effort` is a level of the model. Unknown keys stay out.
 */
export async function createSession(input: CreateSessionInput = {}): Promise<SessionSummary> {
  const body: Record<string, string> = {}
  if (input.model !== undefined) body.model = input.model
  if (input.providerId !== undefined) body.providerId = input.providerId
  if (input.credentialName !== undefined) body.credentialName = input.credentialName
  if (input.cwd !== undefined) body.cwd = input.cwd
  if (input.mode !== undefined) body.mode = input.mode
  if (input.effort !== undefined) body.effort = input.effort
  const response = await send("/api/sessions", body)
  if (!isSummary(response.session)) throw new ApiError(500, "the server sent no session")
  return response.session
}

/** `GET /api/sessions/:id`, or null when the session does not exist. */
export async function getSession(id: string): Promise<SessionDetail | null> {
  const response = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`)
  if (response.status === 404) return null
  const body = await readJson(response)
  if (!isSummary(body.session)) throw new ApiError(500, "the server sent no session")
  const history = Array.isArray(body.history) ? body.history.filter(isHistoryMessage) : []
  return { backend: "core", transport: transportOf(body), session: body.session, history }
}

/**
 * `POST /api/sessions/:id/answers`. `answer` is the id of the chosen
 * {@link AskUserData.options} entry, or `null` to decline.
 */
export async function answerAsk(id: string, askId: string, answer: string | null): Promise<void> {
  await send(`/api/sessions/${encodeURIComponent(id)}/answers`, { askId, answer })
}

/**
 * The body of `POST /api/sessions/:id/target` for `input`: only the four
 * target keys, and only the ones that are set. The server refuses any other
 * key. The token is never part of it: it goes in the `Authorization` header.
 */
export function targetBody(input: SetTargetInput): Record<string, string | null> {
  const body: Record<string, string | null> = {}
  if (input.credentialName !== undefined) body.credentialName = input.credentialName
  if (input.providerId !== undefined) body.providerId = input.providerId
  if (input.model !== undefined) body.model = input.model
  if (input.effort !== undefined) body.effort = input.effort
  return body
}

/**
 * `POST /api/sessions/:id/target`: change the credential, provider, model or
 * effort of one session. It works while a turn runs or waits. Returns the
 * new summary. A refusal throws {@link ApiError} with the server's reason.
 */
export async function setSessionTarget(id: string, input: SetTargetInput): Promise<SessionSummary> {
  const response = await send(`/api/sessions/${encodeURIComponent(id)}/target`, targetBody(input))
  if (!isSummary(response.session)) throw new ApiError(500, "the server sent no session")
  return response.session
}

/** `POST /api/sessions/:id/abort`. True when a turn was running. */
export async function abortTurn(id: string): Promise<boolean> {
  const body = await send(`/api/sessions/${encodeURIComponent(id)}/abort`, {})
  return body.aborted === true
}
