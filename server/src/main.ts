/**
 * Entry point: `bun run start`. Serves the built app on localhost.
 *
 * Environment: `HOST` (default `127.0.0.1`), `PORT` (default 4317), and
 * `APP_DIR` (default `../app/dist` from this package).
 *
 * @module main
 */

import { join } from "node:path"

import { startServer } from "./server.ts"

const DEFAULT_PORT = 4317

const server = startServer({
  appDir: process.env.APP_DIR ?? join(import.meta.dir, "..", "..", "app", "dist"),
  hostname: process.env.HOST ?? "127.0.0.1",
  port: process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT,
})

console.log(`minimal-agent web: ${server.url.href}`)
