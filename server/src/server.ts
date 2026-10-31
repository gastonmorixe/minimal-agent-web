/**
 * The web server: `Bun.serve` on localhost.
 *
 * Today it serves the built app (`app/dist`) and one demo route that streams
 * a canned golden run as an AI SDK UI message stream. The session API of spec
 * 4.2 (S53) and the bearer token of spec 4.5 (S57) come next and replace the
 * demo route.
 *
 * @module server
 */

import { resolve, sep } from "node:path"

import { UI_MESSAGE_STREAM_HEADERS } from "./chat-stream/chunks.ts"
import { GOLDEN_RUNS } from "./chat-stream/golden-runs.ts"
import { encodeChatStream } from "./chat-stream/sse.ts"

/** Options for {@link startServer}. */
export interface ServerOptions {
  /** Directory with the built app (`index.html` and its assets). */
  appDir: string
  /** Defaults to `127.0.0.1` (spec 4.5). */
  hostname?: string
  /** Defaults to 0 (a free port). */
  port?: number
}

/** Path of the demo chat route. Removed when the session API lands (S53). */
export const DEMO_CHAT_PATH = "/api/demo/chat"

const DEMO_RUN = "tool-turn"

/** Start the server. Stop it with `server.stop()`. */
export function startServer(options: ServerOptions): ReturnType<typeof Bun.serve> {
  const appDir = resolve(options.appDir)
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === DEMO_CHAT_PATH && request.method === "POST") return demoChat()
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        return Response.json({ error: "not found" }, { status: 404 })
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405 })
      }
      return serveApp(appDir, pathname)
    },
  })
}

/** Stream the canned demo run, as the messages route will stream a real one. */
function demoChat(): Response {
  const run = GOLDEN_RUNS.find((candidate) => candidate.name === DEMO_RUN)
  return new Response(encodeChatStream(run?.inputs ?? []), { headers: UI_MESSAGE_STREAM_HEADERS })
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
  if (await index.exists()) return new Response(index)
  return new Response("app not built: run `bun run build`", { status: 503 })
}
