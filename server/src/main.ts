/**
 * Entry point: `bun run start`. Serves the built app and the session API on
 * localhost, with the fake backend (the core-backed backend comes with S53).
 *
 * Environment:
 * - `HOST` (default `127.0.0.1`) and `PORT` (default 4317).
 * - `MA_WEB_ALLOW_REMOTE=1` allows a non-loopback `HOST`. Without it the
 *   server refuses to start on one.
 * - `APP_DIR` (default `../app/dist` from this package).
 * - `MA_WEB_TOKEN`: the bearer token. Default: a new random token per start.
 *   `bun run dev` sets it, so a restart under `--watch` keeps the open tab working.
 * - `MA_WEB_APP_URL`: the app URL to print (the Vite URL in development).
 * - `MA_WEB_FAKE_STEP_MS`: real time between fake run steps (default 25).
 *
 * The one line with the token is the start banner on stdout: the URL to open,
 * with the token in the fragment. Nothing else prints the token.
 *
 * @module main
 */

import { join } from "node:path"

import { FakeBackend } from "./backend/fake/fake-backend.ts"
import { BindRefusedError, createToken } from "./security/security.ts"
import { startServer } from "./server.ts"

const DEFAULT_PORT = 4317

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : Number(value)
}

const backend = new FakeBackend({ stepDelayMs: numberFromEnv("MA_WEB_FAKE_STEP_MS") })
const token = process.env.MA_WEB_TOKEN || createToken()

let server: ReturnType<typeof startServer>
try {
  server = startServer({
    appDir: process.env.APP_DIR ?? join(import.meta.dir, "..", "..", "app", "dist"),
    backend,
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
console.log("minimal-agent web: FAKE backend (canned replies, no model is called).")
console.log(`minimal-agent web: open ${appUrl.href}`)

function shutdown(): void {
  backend.close()
  void server.stop(true)
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
