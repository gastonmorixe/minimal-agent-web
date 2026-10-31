import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { RuntimeBackend } from "./backend/runtime-backend.ts"
import { BindRefusedError } from "./security/security.ts"
import { startServer } from "./server.ts"

const TOKEN = "test-token-0123456789-abcdefghijklmnop"
const TRANSPORT = { kind: "scripted" as const, description: "scripted, for tests" }

function backend() {
  return new RuntimeBackend({
    // oxlint-disable-next-line require-yield -- this test never streams a turn.
    sendFn: async function* () {
      return { blocks: [], text: "", stopReason: "end_turn" }
    },
  })
}

let root: string
let appDir: string
let server: ReturnType<typeof startServer>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ma-web-server-"))
  appDir = join(root, "dist")
  mkdirSync(join(appDir, "assets"), { recursive: true })
  writeFileSync(join(appDir, "index.html"), "<!doctype html><title>app</title>")
  writeFileSync(join(appDir, "assets", "app.js"), "console.log(1)")
  writeFileSync(join(root, "secret.txt"), "outside the app dir")
  server = startServer({ appDir, backend: backend(), transport: TRANSPORT, token: TOKEN })
})

afterAll(() => {
  void server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, server.url), init)
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

describe("static app", () => {
  test("serves the app and its assets without a token", async () => {
    expect(await (await get("/")).text()).toContain("<title>app</title>")
    const asset = await get("/assets/app.js")
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe("console.log(1)")
  })

  test("falls back to index.html for client routes", async () => {
    expect(await (await get("/sessions/abc")).text()).toContain("<title>app</title>")
  })

  test("never serves files outside the app directory", async () => {
    for (const path of ["/%2e%2e/secret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt"]) {
      const response = await get(path)
      expect(await response.text()).not.toContain("outside the app dir")
    }
  })

  test("refuses other methods", async () => {
    expect((await get("/", { method: "POST" })).status).toBe(405)
  })
})

describe("bearer token (S57)", () => {
  test("binds 127.0.0.1 by default", () => {
    expect(server.hostname).toBe("127.0.0.1")
  })

  test("refuses an API call without a token", async () => {
    const response = await get("/api/sessions")
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toStartWith("Bearer")
    expect(await response.json()).toEqual({ error: "unauthorized" })
  })

  test("refuses an API call with a wrong token, and does not echo it", async () => {
    for (const header of [
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      "Bearer ",
      `Basic ${TOKEN}`,
      TOKEN,
      `Bearer ${TOKEN} extra`,
    ]) {
      const response = await get("/api/sessions", { headers: { authorization: header } })
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(TOKEN.slice(0, 10))
    }
  })

  test("accepts an API call with the right token", async () => {
    const response = await get("/api/sessions", { headers: auth(TOKEN) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ backend: "core", transport: TRANSPORT, sessions: [] })
  })

  test("guards every API path, unknown ones included", async () => {
    const paths = [
      ["GET", "/api"],
      ["GET", "/api/nope"],
      ["POST", "/api/sessions"],
      ["GET", "/api/sessions/session-1"],
      ["POST", "/api/sessions/session-1/messages"],
      ["GET", "/api/sessions/session-1/events"],
      ["POST", "/api/sessions/session-1/answers"],
      ["POST", "/api/sessions/session-1/abort"],
    ] as const
    for (const [method, path] of paths) {
      expect((await get(path, { method })).status).toBe(401)
    }
    expect((await get("/api/nope", { headers: auth(TOKEN) })).status).toBe(404)
  })

  test("sends no CORS headers, even to a cross-origin request or a preflight", async () => {
    const origin = "http://evil.example"
    const responses = [
      await get("/api/sessions", { headers: { origin, ...auth(TOKEN) } }),
      await get("/api/sessions", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" },
      }),
      await get("/", { headers: { origin } }),
    ]
    for (const response of responses) {
      for (const name of response.headers.keys()) expect(name).not.toStartWith("access-control-")
    }
    expect(responses[1]?.status).toBe(401)
  })

  test("sets the security headers on every answer", async () => {
    for (const response of [await get("/"), await get("/api/sessions")]) {
      expect(response.headers.get("x-frame-options")).toBe("DENY")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    }
  })

  test("refuses a short or unsafe token", () => {
    for (const token of ["short", `${"a".repeat(40)} b`, `${"a".repeat(40)}#`]) {
      expect(() =>
        startServer({ appDir, backend: backend(), transport: TRANSPORT, token, port: 0 }),
      ).toThrow("API token")
    }
  })
})

describe("bind address (S57)", () => {
  test("refuses a non-loopback host unless allowed on purpose", () => {
    for (const hostname of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(() =>
        startServer({ appDir, backend: backend(), transport: TRANSPORT, token: TOKEN, hostname }),
      ).toThrow(BindRefusedError)
    }
  })

  test("binds a non-loopback host when allowRemoteBind is set", () => {
    const remote = startServer({
      appDir,
      backend: backend(),
      transport: TRANSPORT,
      token: TOKEN,
      hostname: "0.0.0.0",
      allowRemoteBind: true,
    })
    expect(remote.hostname).toBe("0.0.0.0")
    void remote.stop(true)
  })

  test("binds the IPv4 loopback names (::1 is covered by isLoopbackHost)", () => {
    for (const hostname of ["localhost", "127.0.0.1"]) {
      const local = startServer({
        appDir,
        backend: backend(),
        transport: TRANSPORT,
        token: TOKEN,
        hostname,
      })
      void local.stop(true)
    }
  })
})

describe("main.ts", () => {
  const MAIN = join(import.meta.dir, "main.ts")

  function runMain(env: Record<string, string>) {
    return Bun.spawn(["bun", MAIN], {
      env: { ...process.env, APP_DIR: appDir, PORT: "0", ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
  }

  test("refuses HOST=0.0.0.0 without MA_WEB_ALLOW_REMOTE=1", async () => {
    const child = runMain({ HOST: "0.0.0.0" })
    expect(await child.exited).toBe(2)
    expect(await new Response(child.stderr).text()).toContain("refusing to bind 0.0.0.0")
  })

  test("prints the app URL with a fresh random token in the fragment only", async () => {
    const child = runMain({ MA_WEB_TOKEN: "" })
    const reader = child.stdout.getReader()
    let out = ""
    while (!out.includes("open ")) {
      const { value, done } = await reader.read()
      if (done) break
      out += new TextDecoder().decode(value)
    }
    child.kill()
    await child.exited
    expect(out).toContain("scripted transport")
    const url = new URL(/open (\S+)/u.exec(out)?.[1] ?? "")
    expect(url.hostname).toBe("127.0.0.1")
    expect(url.search).toBe("")
    expect(url.pathname).toBe("/")
    expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/u)
  })
})
