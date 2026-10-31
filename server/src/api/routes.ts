/**
 * The session API (spec 4.2) over a {@link SessionBackend}.
 *
 * | Method and path                   | Answer                                                 |
 * | --------------------------------- | ------------------------------------------------------ |
 * | `POST /api/sessions`              | 201 `{ session }`                                      |
 * | `GET /api/sessions`               | `{ backend, sessions }`, newest first                  |
 * | `GET /api/sessions/:id`           | `{ backend, session, history }` (`backend/history.ts`) |
 * | `POST /api/sessions/:id/messages` | AI SDK UI message stream (SSE), body `{ text }`        |
 * | `GET /api/sessions/:id/events`    | Event log as SSE, `id: seq`, resumes at `Last-Event-ID` |
 * | `POST /api/sessions/:id/answers`  | `{ ok: true }`, body `{ askId, answer }`               |
 * | `POST /api/sessions/:id/abort`    | `{ aborted }`, body `{ reason? }` (optional)           |
 *
 * Errors are JSON `{ error }`: 400 bad body, 404 no session, 405 wrong
 * method, 409 busy session or no such pending ask. The caller (`server.ts`)
 * checks the bearer token before any route runs.
 *
 * @module api/routes
 */

import { BackendError, type CreateSessionInput, type SessionBackend } from "../backend/backend.ts"
import { historyFromEntries } from "../backend/history.ts"
import type { AskAnswer } from "../core-mirror/events.ts"
import type { SessionEntry } from "../core-mirror/session-entry.ts"

import { chatStreamResponse, eventLogResponse, type StreamOptions } from "./streams.ts"

/** What the routes need besides the request. */
export interface ApiContext extends StreamOptions {
  backend: SessionBackend
}

/** Largest request body the API reads. */
export const MAX_BODY_BYTES = 1024 * 1024

/** Longest message text `POST /messages` accepts. */
export const MAX_MESSAGE_CHARS = 100_000

const SESSIONS = /^\/api\/sessions\/?$/u
const SESSION = /^\/api\/sessions\/([^/]+)(?:\/(messages|events|answers|abort))?\/?$/u

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } })
}

function failure(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store", ...headers } })
}

function methodNotAllowed(allow: string): Response {
  return failure(405, "method not allowed", { allow })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Read a JSON object body. An empty body reads as `{}`. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (length > MAX_BODY_BYTES) throw new BadRequest("body too large")
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new BadRequest("body too large")
  if (text.trim().length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new BadRequest("body is not JSON")
  }
  if (!isRecord(value)) throw new BadRequest("body must be a JSON object")
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new BadRequest(`${key} must be a string`)
  return value
}

function parseCreate(body: Record<string, unknown>): CreateSessionInput {
  const input: CreateSessionInput = {}
  const model = optionalString(body, "model")
  const cwd = optionalString(body, "cwd")
  const mode = optionalString(body, "mode")
  if (model !== undefined) input.model = model
  if (cwd !== undefined) input.cwd = cwd
  if (mode !== undefined) input.mode = mode
  return input
}

function parseMessage(body: Record<string, unknown>): string {
  const text = body.text
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new BadRequest("text must be a non-empty string")
  }
  if (text.length > MAX_MESSAGE_CHARS) throw new BadRequest("text is too long")
  return text
}

function parseAnswer(body: Record<string, unknown>): { askId: string; answer: AskAnswer } {
  const { askId, answer } = body
  if (typeof askId !== "string" || askId.length === 0) throw new BadRequest("askId is required")
  if (!isRecord(answer)) throw new BadRequest("answer must be an object")
  if (answer.kind === "approval" && typeof answer.approved === "boolean") {
    const reason = optionalString(answer, "reason")
    return {
      askId,
      answer: { kind: "approval", approved: answer.approved, ...(reason ? { reason } : {}) },
    }
  }
  if (answer.kind === "text" && typeof answer.text === "string") {
    return { askId, answer: { kind: "text", text: answer.text } }
  }
  throw new BadRequest('answer must be {kind: "approval", approved} or {kind: "text", text}')
}

/** The whole log of a session: a replay from seq 0, read synchronously. */
export function readWholeLog(backend: SessionBackend, id: string): SessionEntry[] {
  const entries: SessionEntry[] = []
  const unsubscribe = backend.subscribe(id, (entry) => entries.push(entry), { fromSeq: 0 })
  unsubscribe()
  return entries
}

/** Answer one `/api` request. The token is already checked. */
export async function handleApi(request: Request, context: ApiContext): Promise<Response> {
  try {
    return await route(request, context)
  } catch (error) {
    if (error instanceof BadRequest) return failure(400, error.message)
    if (error instanceof BackendError) {
      const status = { not_found: 404, busy: 409, no_such_ask: 409, invalid: 400 }[error.code]
      return failure(status, error.message)
    }
    throw error
  }
}

async function route(request: Request, context: ApiContext): Promise<Response> {
  const { backend } = context
  const { pathname } = new URL(request.url)
  const { method } = request

  if (SESSIONS.test(pathname)) {
    if (method === "GET")
      return json({ backend: backend.kind, sessions: await backend.listSessions() })
    if (method === "POST") {
      const session = await backend.createSession(parseCreate(await readBody(request)))
      return json({ session }, 201)
    }
    return methodNotAllowed("GET, POST")
  }

  const match = SESSION.exec(pathname)
  const rawId = match?.[1]
  if (match === null || rawId === undefined) return failure(404, "not found")
  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    return failure(400, "bad session id")
  }
  const action = match[2]

  switch (action) {
    case undefined: {
      if (method !== "GET") return methodNotAllowed("GET")
      const session = await backend.getSession(id)
      if (session === undefined) return failure(404, `no session ${id}`)
      const history = historyFromEntries(readWholeLog(backend, id))
      return json({ backend: backend.kind, session, history })
    }
    case "messages": {
      if (method !== "POST") return methodNotAllowed("POST")
      const text = parseMessage(await readBody(request))
      return chatStreamResponse(await backend.startTurn(id, { text }), context)
    }
    case "events": {
      if (method !== "GET") return methodNotAllowed("GET")
      if ((await backend.getSession(id)) === undefined) return failure(404, `no session ${id}`)
      return eventLogResponse(backend, id, request, context)
    }
    case "answers": {
      if (method !== "POST") return methodNotAllowed("POST")
      const { askId, answer } = parseAnswer(await readBody(request))
      backend.answer(id, askId, answer)
      return json({ ok: true })
    }
    case "abort": {
      if (method !== "POST") return methodNotAllowed("POST")
      const reason = optionalString(await readBody(request), "reason")
      return json({ aborted: backend.abort(id, reason) })
    }
    default:
      return failure(404, "not found")
  }
}
