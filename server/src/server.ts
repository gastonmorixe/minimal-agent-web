/**
 * The web server: `Bun.serve` on localhost.
 *
 * It serves the built app (`app/dist`) and the session API of spec 4.2
 * (`api/routes.ts`) over a {@link SessionBackend}. Every `/api` request needs
 * the bearer token (spec 4.5, `security/security.ts`). The static app does
 * not: it holds no secret, and it reads the token from the URL fragment.
 *
 * @module server
 */

import { resolve, sep } from "node:path"

import { handleApi, type TransportInfo } from "./api/routes.ts"
import type { SessionBackend } from "./backend/backend.ts"
import { checkBindHost, checkToken, isAuthorized, unauthorized } from "./security/security.ts"

/** Options for {@link startServer}. */
export interface ServerOptions {
  /** Directory with the built app (`index.html` and its assets). */
  appDir: string
  /** What answers the session API. */
  backend: SessionBackend
  /**
   * What `GET /api/sessions` says about the model transport. Default:
   * `backend.transport` (see `backend/runtime-backend.ts`).
   */
  transport?: TransportInfo
  /** The bearer token every `/api` request must carry. */
  token: string
  /** Defaults to `127.0.0.1` (spec 4.5). */
  hostname?: string
  /** Defaults to 0 (a free port). */
  port?: number
  /** Allow a non-loopback `hostname`. Off unless set on purpose. */
  allowRemoteBind?: boolean
  /** Time between SSE keep-alive comments. Default 15 s. */
  keepAliveMs?: number
}

const DEFAULT_KEEP_ALIVE_MS = 15_000

/** Headers on every answer. No `Access-Control-*` header: no CORS (spec 4.5). */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
} as const

function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value)
  return response
}

/**
 * Start the server. Stop it with `server.stop()`.
 *
 * @throws BindRefusedError for a non-loopback `hostname` without `allowRemoteBind`
 */
export function startServer(options: ServerOptions): ReturnType<typeof Bun.serve> {
  const hostname = options.hostname ?? "127.0.0.1"
  checkBindHost(hostname, options.allowRemoteBind ?? false)
  checkToken(options.token)
  const appDir = resolve(options.appDir)
  const { backend, token } = options
  const transport = options.transport ?? backend.transport
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS
  return Bun.serve({
    hostname,
    port: options.port ?? 0,
    async fetch(request, server) {
      const { pathname } = new URL(request.url)
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        if (!isAuthorized(request, token)) return withSecurityHeaders(unauthorized())
        // Streams stay open while a run waits; keep-alives replace the idle timeout.
        server.timeout(request, 0)
        return withSecurityHeaders(await handleApi(request, { backend, transport, keepAliveMs }))
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return withSecurityHeaders(new Response("method not allowed", { status: 405 }))
      }
      return withSecurityHeaders(await serveApp(appDir, pathname))
    },
  })
}

/**
 * Serve a file from the app directory. A path with no file falls back to
 * `index.html`, so client routes work after a reload. A path that resolves
 * outside the app directory is refused.
 */
async function serveApp(appDir: string, pathname: string): Promise<Response> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return new Response("bad request", { status: 400 })
  }
  const target = resolve(appDir, `.${decoded}`)
  if (target !== appDir && !target.startsWith(appDir + sep)) {
    return new Response("not found", { status: 404 })
  }
  const file = Bun.file(target)
  if (target !== appDir && (await file.exists())) return new Response(file)
  const index = Bun.file(resolve(appDir, "index.html"))
  if (await index.exists()) return new Response(index, { headers: { "cache-control": "no-cache" } })
  return new Response("app not built: run `bun run build`", { status: 503 })
}
