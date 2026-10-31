import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { startServer } from "./server.ts"

let appDir: string
let server: ReturnType<typeof startServer>

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "ma-web-server-"))
  appDir = join(root, "dist")
  mkdirSync(join(appDir, "assets"), { recursive: true })
  writeFileSync(join(appDir, "index.html"), "<!doctype html><title>app</title>")
  writeFileSync(join(appDir, "assets", "app.js"), "console.log(1)")
  writeFileSync(join(root, "secret.txt"), "outside the app dir")
  server = startServer({ appDir })
})

afterAll(() => {
  void server.stop(true)
  rmSync(join(appDir, ".."), { recursive: true, force: true })
})

function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, server.url), init)
}

describe("startServer", () => {
  test("binds 127.0.0.1 by default", () => {
    expect(server.hostname).toBe("127.0.0.1")
  })

  test("serves the app and its assets", async () => {
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

  test("answers unknown API paths with 404", async () => {
    const response = await get("/api/nope")
    expect(response.status).toBe(404)
  })
})
