/**
 * The paste plugin in the web host (paste-plugin v3, PLAN.md section 5 E1,
 * integration item I8).
 *
 * A web session has no paste input. But a paste ref can reach a web send: in
 * the history of a session, or typed by a client. The web host boots the same
 * core plugin host as the CLI, so `ma-paste-plugin` loads and its
 * `message.willSend` hook expands a ref before the request goes to the
 * provider.
 *
 * The web boots the host as `main.ts` does: `sessionsDir` is the persist dir
 * (or `null` for memory only), and `isOwnedSession` reads the live session set
 * of the backend. Each test boots a backend with a stub provider, the real
 * paste plugin and the real sideband codec plugin (without a codec the paste
 * hook correctly changes nothing), then reads the request that the stub got.
 *
 * @module backend/runtime-backend.paste.test
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"
import type { AgentEvent } from "@minimal-agent/core/sdk/events"

import { RuntimeBackend } from "./runtime-backend.ts"
import {
  type StubProviderHome,
  stubBootOptions,
  writeStubProviderHome,
} from "./stub-provider.fixture.ts"

/** The plugins checkout next to this repo. */
const PLUGINS_DIR = join(import.meta.dir, "..", "..", "..", "..", "minimal-agent-plugins")
/** The real plugins that the test loads. */
const REAL_PLUGINS = ["ma-paste-plugin", "ma-sideband-plugin"]

const savedHome = process.env.MINIMAL_AGENT_HOME
const PASTE_TEXT = "line one of the paste\nline two of the paste"

/** One booted web backend, as `main.ts` makes it. */
interface WebHost {
  stub: StubProviderHome
  host: BootedHost
  backend: RuntimeBackend
  persistDir: string | undefined
}

const open: WebHost[] = []

/**
 * Boot a web backend. `persist` gives a persist dir; `false` is memory only.
 * Each call uses a new provider id: the model registry is process-wide.
 */
async function bootWeb(id: string, persist: boolean): Promise<WebHost> {
  const stub = writeStubProviderHome(id, { recordMessages: true })
  for (const name of REAL_PLUGINS) {
    cpSync(join(PLUGINS_DIR, name), join(stub.home, "plugins", name), {
      recursive: true,
      filter: (src) => !src.endsWith(".test.ts") && !src.includes("__fixtures__"),
    })
  }
  const persistDir = persist ? join(stub.root, "web-sessions") : undefined
  if (persistDir !== undefined) mkdirSync(persistDir, { recursive: true })
  const liveSessionIds = new Set<string>()
  const host = await bootHost({
    ...stubBootOptions(stub),
    version: "7.7.7",
    sessionsDir: persistDir ?? null,
    isOwnedSession: (sid) => liveSessionIds.has(sid),
  })
  const backend = new RuntimeBackend({
    host,
    retryCeilingMs: 5,
    version: "7.7.7",
    liveSessionIds,
    ...(persistDir !== undefined ? { persistDir } : {}),
  })
  const web = { stub, host, backend, persistDir }
  open.push(web)
  return web
}

afterEach(() => {
  for (const web of open.splice(0)) {
    web.backend.close()
    rmSync(web.stub.root, { recursive: true, force: true })
  }
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
})

/** The `messages` of each provider request, as JSON text. */
function requestMessages(stub: StubProviderHome): string[] {
  if (!existsSync(stub.requestLog)) return []
  return readFileSync(stub.requestLog, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const record: unknown = JSON.parse(l)
      const messages =
        typeof record === "object" && record !== null ? Reflect.get(record, "messages") : null
      return JSON.stringify(messages ?? null)
    })
}

async function turn(web: WebHost, sid: string, text: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of (await web.backend.startTurn(sid, { text })).events) out.push(event)
  return out
}

/** A paste ref with typed attrs that are wrong on purpose: the file values must win. */
function pasteRef(web: WebHost, id: string): string {
  return web.host.loader.sideband().render("paste", { attrs: { id, bytes: 1, lines: 1 } })
}

/** Write a paste file where the CLI paste hook writes it: `<dir>/<sid>.files/paste/<id>.txt`. */
function writePaste(dir: string, sid: string, id: string, text: string): void {
  const filesDir = join(dir, `${sid}.files`, "paste")
  mkdirSync(filesDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(filesDir, `${id}.txt`), text, { mode: 0o600 })
}

describe("paste plugin in the web host", () => {
  test("with a persist dir, a ref in a web turn expands to the file text", async () => {
    const web = await bootWeb("pastep", true)
    expect(web.host.loader.loadedPluginIds()).toContain("paste")
    expect(web.host.loader.sideband().ready).toBe(true)
    const { id: sid } = await web.backend.createSession({ model: web.stub.modelId })
    writePaste(web.persistDir ?? "", sid, "abc12", PASTE_TEXT)

    const events = await turn(web, sid, `look at this: ${pasteRef(web, "abc12")}`)

    expect(events.some((e) => e.type === "run_finished")).toBe(true)
    const sent = requestMessages(web.stub).at(-1) ?? ""
    expect(sent).toContain("line one of the paste")
    expect(sent).toContain("line two of the paste")
    // bytes and lines come from the file, not from the ref.
    expect(sent).toContain(`bytes=\\"${Buffer.byteLength(PASTE_TEXT)}\\"`)
    expect(sent).toContain(`lines=\\"2\\"`)
  })

  test("memory only: no grant, one warning in the session log, the ref goes unchanged", async () => {
    const web = await bootWeb("pastem", false)
    const { id: sid } = await web.backend.createSession({ model: web.stub.modelId })
    const warnings: string[] = []
    web.backend.subscribe(sid, (entry) => {
      if (entry.ch !== "diag") return
      if (entry.data.code.endsWith("host.sessions-files")) warnings.push(entry.data.message)
    })
    const ref = pasteRef(web, "abc12")

    const events = await turn(web, sid, `look at this: ${ref}`)
    // The plugin host is built at the first hook call of a run, so the warning
    // goes to the log of that session. A second turn gives no second warning.
    await turn(web, sid, "again")

    expect(events.some((e) => e.type === "run_finished")).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("(memory-only)")
    expect(warnings[0]).toContain("sessions:files")
    // Each turn makes two requests (a tool round). Check all of them.
    const sent = requestMessages(web.stub)
    expect(sent.some((m) => m.includes(JSON.stringify(ref).slice(1, -1)))).toBe(true)
    expect(sent.some((m) => m.includes("line one of the paste"))).toBe(false)
  })

  test("a session does not read the paste file of another live session", async () => {
    const web = await bootWeb("pastex", true)
    const a = await web.backend.createSession({ model: web.stub.modelId })
    const b = await web.backend.createSession({ model: web.stub.modelId })
    // The file is in session B's dir. Session A sends the ref.
    writePaste(web.persistDir ?? "", b.id, "abc12", PASTE_TEXT)
    const ref = pasteRef(web, "abc12")

    await turn(web, a.id, `look at this: ${ref}`)

    const sent = requestMessages(web.stub).at(-1) ?? ""
    expect(sent).not.toContain("line one of the paste")
    expect(sent).toContain(JSON.stringify(ref).slice(1, -1))
  })
})
