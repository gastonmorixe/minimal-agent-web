/**
 * Entry point: `bun run start`. Serves the built app and the session API on
 * localhost, over `RuntimeBackend` (S53) on core's real `createRuntime` /
 * `Session`.
 *
 * Boot (WEB-PLUGINS-001): at start, the server calls core's `bootHost()`
 * (`@minimal-agent/core/host-kit/host-boot`) once. It loads the provider
 * plugins, the manifest plugins, the tools, and the auth store, in the same
 * order as the CLI. Each boot diagnostic goes to stderr, one line each. When
 * no provider or no model resolves, the server prints why to stderr and
 * exits 2. With `MA_WEB_SCRIPTED=1`, the server does not boot. It uses the
 * scripted transport instead (see `backend/runtime-backend.ts`).
 *
 * Environment:
 * - `MA_WEB_SCRIPTED=1`: scripted mode. No boot, no provider, no tools.
 * - `MINIMAL_AGENT_HOME`, `MINIMAL_AGENT_NO_PLUGIN_SYNC`,
 *   `MINIMAL_AGENT_PLUGIN_SIBLINGS`, `MINIMAL_AGENT_DISABLE_PLUGINS`,
 *   `MINIMAL_AGENT_ENABLE_PLUGINS`: read by `bootHost()` (core
 *   `docs/host-boot.md`).
 * - `HOST` (default `127.0.0.1`) and `PORT` (default 4317).
 * - `MA_WEB_ALLOW_REMOTE=1` allows a non-loopback `HOST`. Without it the
 *   server refuses to start on one.
 * - `APP_DIR` (default `../app/dist` from this package).
 * - `MA_WEB_TOKEN`: the bearer token. Default: a new random token per start.
 *   `bun run dev` sets it, so a restart under `--watch` keeps the open tab working.
 * - `MA_WEB_APP_URL`: the app URL to print (the Vite URL in development).
 * - `MA_WEB_SCRIPT_STEP_MS`: scripted mode only. Real time between scripted
 *   transport steps (default 15).
 * - `MA_WEB_RETRY_CEILING_MS`: retry/quota-wait backoff ceiling, in ms
 *   (default 300 — see `backend/runtime-backend.ts`'s `DEFAULT_RETRY_CEILING_MS`).
 * - `MA_WEB_PERSIST_DIR`: persist sessions here (core's real `SessionStore` +
 *   durable event log, so a session outlives a server restart). Default:
 *   unset, memory only — a session is gone once the process exits. Never
 *   core's own default sessions directory (`~/.minimal-agent/sessions`):
 *   web sessions are not CLI sessions, and must not share a directory with
 *   them.
 *
 * The one line with the token is the start banner on stdout: the URL to open,
 * with the token in the fragment. Nothing else prints the token. No line
 * prints credentials: the boot diagnostics and the auth errors hold none.
 *
 * @module main
 */

import { join } from "node:path"

import {
  type BootedHost,
  bootHost,
  type HostBootOptions,
} from "@minimal-agent/core/host-kit/host-boot"
import { resolveSiblingPluginRoots } from "@minimal-agent/core/host-kit/plugin-loader"

import { RuntimeBackend } from "./backend/runtime-backend.ts"
import { createScriptedTransport } from "./backend/transport/scripted-transport.ts"
import { BindRefusedError, checkBindHost, createToken } from "./security/security.ts"
import { startServer } from "./server.ts"

const DEFAULT_PORT = 4317

/** The repo root: the web install dir. `bootHost` scans `<root>/plugins` and `../minimal-agent-plugins`. */
const INSTALL_DIR = join(import.meta.dir, "..", "..")

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : Number(value)
}

/**
 * The plugin roots for `bootHost`. The web host computes them here, in one
 * place, and passes each one explicitly: core plans to stop computing
 * plugin roots itself (S40).
 */
function pluginRoots(): HostBootOptions {
  return {
    embeddedDir: INSTALL_DIR,
    projectDir: process.cwd(),
    siblingDirs: resolveSiblingPluginRoots(INSTALL_DIR),
    ...(process.env.HOME ? { homeDir: join(process.env.HOME, ".agents") } : { homeDir: null }),
  }
}

/** Print one line to stderr and exit with `code`. */
function fail(message: string, code: number): never {
  console.error(`minimal-agent web: ${message}`)
  process.exit(code)
}

/**
 * Boot the host. Print each diagnostic to stderr. Exit 2 when no provider
 * or no model resolves.
 */
async function bootOrExit(): Promise<BootedHost> {
  let host: BootedHost
  try {
    host = await bootHost(pluginRoots())
  } catch (error) {
    fail(`boot failed: ${error instanceof Error ? error.message : String(error)}`, 2)
  }
  for (const d of host.diagnostics) console.error(`minimal-agent web: boot ${d.kind}: ${d.message}`)
  const hint =
    "Install a provider plugin in <agent home>/plugins (see core docs/host-boot.md), " +
    "or set MA_WEB_SCRIPTED=1 for the scripted transport."
  if (host.providers.length === 0)
    fail(`no provider plugin resolved (home ${host.home}). ${hint}`, 2)
  if (!host.models.some((m) => m.id === host.defaultModelId)) {
    fail(`no model resolved (default "${host.defaultModelId}"). ${hint}`, 2)
  }
  return host
}

const hostname = process.env.HOST ?? "127.0.0.1"
const allowRemoteBind = process.env.MA_WEB_ALLOW_REMOTE === "1"
// Refuse a non-loopback bind before the boot loads any plugin code.
try {
  checkBindHost(hostname, allowRemoteBind)
} catch (error) {
  fail(
    error instanceof Error ? error.message : String(error),
    error instanceof BindRefusedError ? 2 : 1,
  )
}

const scripted = process.env.MA_WEB_SCRIPTED === "1"
const persistDir = process.env.MA_WEB_PERSIST_DIR
const retryCeilingMs = numberFromEnv("MA_WEB_RETRY_CEILING_MS")
const scriptStepDelayMs = numberFromEnv("MA_WEB_SCRIPT_STEP_MS")
const backend = new RuntimeBackend({
  ...(scripted
    ? {
        // A factory, not a shared instance: each session needs its own transport
        // (see `runtime-backend.ts`'s module doc) so concurrent sessions never
        // corrupt each other's scripted retry/quota attempt counts.
        sendFn: () => createScriptedTransport({ stepDelayMs: scriptStepDelayMs }),
      }
    : { host: await bootOrExit() }),
  ...(persistDir === "" ? {} : { persistDir }),
  ...(retryCeilingMs === undefined ? {} : { retryCeilingMs }),
})
const token = process.env.MA_WEB_TOKEN || createToken()

let server: ReturnType<typeof startServer>
try {
  server = startServer({
    appDir: process.env.APP_DIR ?? join(import.meta.dir, "..", "..", "app", "dist"),
    backend,
    token,
    hostname,
    port: numberFromEnv("PORT") ?? DEFAULT_PORT,
    allowRemoteBind,
  })
} catch (error) {
  console.error(`minimal-agent web: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(error instanceof BindRefusedError ? 2 : 1)
}

const appUrl = new URL(process.env.MA_WEB_APP_URL ?? server.url.href)
appUrl.hash = `token=${token}`
console.log(`minimal-agent web: ${backend.transport.description}`)
console.log(`minimal-agent web: open ${appUrl.href}`)
function shutdown(): void {
  backend.close()
  void server.stop(true)
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
