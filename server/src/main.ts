/**
 * Entry point: `bun run start`. Serves the built app and the session API on
 * localhost, over `RuntimeBackend` (S53): real `createRuntime` / `Session`,
 * a scripted transport instead of a real model provider (see
 * `backend/runtime-backend.ts`'s module doc for why).
 *
 * Environment:
 * - `HOST` (default `127.0.0.1`) and `PORT` (default 4317).
 * - `MA_WEB_ALLOW_REMOTE=1` allows a non-loopback `HOST`. Without it the
 *   server refuses to start on one.
 * - `APP_DIR` (default `../app/dist` from this package).
 * - `MA_WEB_TOKEN`: the bearer token. Default: a new random token per start.
 *   `bun run dev` sets it, so a restart under `--watch` keeps the open tab working.
 * - `MA_WEB_APP_URL`: the app URL to print (the Vite URL in development).
 * - `MA_WEB_SCRIPT_STEP_MS`: real time between scripted transport steps (default 15).
 * - `MA_WEB_RETRY_CEILING_MS`: retry/quota-wait backoff ceiling, in ms
 *   (default 300 — see `backend/runtime-backend.ts`'s `DEFAULT_RETRY_CEILING_MS`).
 * - `MA_WEB_PERSIST_DIR`: persist sessions here (core's real `SessionStore` +
 *   durable event log, so a session outlives a server restart). Default:
 *   unset, memory only — a session is gone once the process exits. Never
 *   core's own default sessions directory (`~/.minimal-agent/sessions`):
 *   these are scripted demo sessions, not real CLI ones, and must not share
 *   a directory with them.
 *
 * The one line with the token is the start banner on stdout: the URL to open,
 * with the token in the fragment. Nothing else prints the token.
 *
 * @module main
 */

import { join } from "node:path"

import { RuntimeBackend } from "./backend/runtime-backend.ts"
import { createScriptedTransport } from "./backend/transport/scripted-transport.ts"
import { BindRefusedError, createToken } from "./security/security.ts"
import { startServer } from "./server.ts"

const DEFAULT_PORT = 4317

const TRANSPORT = {
  kind: "scripted" as const,
  description:
    "Every reply is a scripted transport, not a real model provider: see AGENTS.md, " +
    '"Session backend".',
}

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : Number(value)
}

const persistDir = process.env.MA_WEB_PERSIST_DIR
const retryCeilingMs = numberFromEnv("MA_WEB_RETRY_CEILING_MS")
const scriptStepDelayMs = numberFromEnv("MA_WEB_SCRIPT_STEP_MS")
const backend = new RuntimeBackend({
  // A factory, not a shared instance: each session needs its own transport
  // (see `runtime-backend.ts`'s module doc) so concurrent sessions never
  // corrupt each other's scripted retry/quota attempt counts.
  sendFn: () => createScriptedTransport({ stepDelayMs: scriptStepDelayMs }),
  ...(persistDir === "" ? {} : { persistDir }),
  ...(retryCeilingMs === undefined ? {} : { retryCeilingMs }),
})
const token = process.env.MA_WEB_TOKEN || createToken()

let server: ReturnType<typeof startServer>
try {
  server = startServer({
    appDir: process.env.APP_DIR ?? join(import.meta.dir, "..", "..", "app", "dist"),
    backend,
    transport: TRANSPORT,
    token,
    hostname: process.env.HOST ?? "127.0.0.1",
    port: numberFromEnv("PORT") ?? DEFAULT_PORT,
    allowRemoteBind: process.env.MA_WEB_ALLOW_REMOTE === "1",
  })
} catch (error) {
  console.error(`minimal-agent web: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(error instanceof BindRefusedError ? 2 : 1)
}

const appUrl = new URL(process.env.MA_WEB_APP_URL ?? server.url.href)
appUrl.hash = `token=${token}`
console.log(`minimal-agent web: ${TRANSPORT.description}`)
console.log(`minimal-agent web: open ${appUrl.href}`)

function shutdown(): void {
  backend.close()
  void server.stop(true)
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
