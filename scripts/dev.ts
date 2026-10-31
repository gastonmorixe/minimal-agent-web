#!/usr/bin/env bun
/**
 * `bun run dev` (S60): the server and Vite together.
 *
 * - The server (`server/src/main.ts`) runs on `HOST`/`PORT` (default
 *   127.0.0.1:4317), with the fake backend, and does not serve the app in
 *   dev (`app/vite.config.ts`'s dev server does that).
 * - Vite (`bun run --cwd app dev`) serves the app on its own port and
 *   proxies `/api` to the server (`API_TARGET`, same default).
 * - One token for the run, generated here and passed to the server. The
 *   server prints the open URL with that token, pointed at Vite's URL
 *   (`MA_WEB_APP_URL`) instead of its own, so the printed link is the one to
 *   open.
 * - Works with core linked by the umbrella's `bun run link:dev`
 *   (`../scripts/link-dev.ts` in the umbrella): that script only swaps
 *   `node_modules/@minimal-agent/core` for a symlink, so this script does
 *   not need to know about it.
 *
 * Either child exiting stops the other. Ctrl-C stops both.
 */

import { randomBytes } from "node:crypto"

const HOST = process.env.HOST ?? "127.0.0.1"
const PORT = process.env.PORT ?? "4317"
const VITE_PORT = process.env.VITE_PORT ?? "5173"
const token = process.env.MA_WEB_TOKEN ?? randomBytes(32).toString("base64url")

const root = new URL("..", import.meta.url).pathname

const server = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: `${root}server`,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    HOST,
    PORT,
    MA_WEB_TOKEN: token,
    MA_WEB_APP_URL: `http://${HOST}:${VITE_PORT}/`,
  },
})

const vite = Bun.spawn(["bun", "x", "vite", "--port", VITE_PORT, "--strictPort"], {
  cwd: `${root}app`,
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, API_TARGET: `http://${HOST}:${PORT}` },
})

let stopping = false

function stop(code: number): void {
  if (stopping) return
  stopping = true
  server.kill()
  vite.kill()
  process.exit(code)
}

process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))

const [serverExit, viteExit] = await Promise.race([
  server.exited.then((code) => [code, undefined] as const),
  vite.exited.then((code) => [undefined, code] as const),
])

console.error(
  serverExit !== undefined
    ? `minimal-agent web dev: the server exited (${serverExit}); stopping Vite too.`
    : `minimal-agent web dev: Vite exited (${viteExit}); stopping the server too.`,
)
stop(serverExit ?? viteExit ?? 1)
