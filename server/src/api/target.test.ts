/**
 * `POST /api/sessions/:id/target` over a real `Bun.serve` and a real
 * `bootHost` with a stub provider plugin: the token check, the strict body,
 * the status codes, and the effort of a new session. The checks of the
 * target itself are in `backend/runtime-backend.target.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { type BootedHost, bootHost } from "@minimal-agent/core/host-kit/host-boot"

import { RuntimeBackend } from "../backend/runtime-backend.ts"
import {
  readRecordedRequests,
  type StubProviderHome,
  stubBootOptions,
  writeStubProviderHome,
} from "../backend/stub-provider.fixture.ts"
import { startServer } from "../server.ts"

const TOKEN = "target-test-token-0123456789abcdefghijkl"
const HEADERS = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }
const savedHome = process.env.MINIMAL_AGENT_HOME

let root: string
let stub: StubProviderHome
let backend: RuntimeBackend
let server: ReturnType<typeof startServer>
let scriptedBackend: RuntimeBackend
let scriptedServer: ReturnType<typeof startServer>

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ma-web-target-"))
  stub = writeStubProviderHome("apitgt", { targetModels: true })
  const booted = await bootHost(stubBootOptions(stub))
  const host: BootedHost = {
    ...booted,
    listCredentials: () => [
      {
        providerId: "apitgt",
        displayName: "apitgt provider",
        authKind: "api-key",
        source: "store",
        credentialName: "second",
        credentialLabel: "second",
      },
    ],
    resolveAuth: (modelId, providerId, credentialName) =>
      Promise.resolve({
        type: "provider",
        auth: {
          kind: "custom",
          headers: { "x-auth-for": `${providerId ?? ""}/${credentialName ?? ""}/${modelId}` },
        },
      }),
  }
  backend = new RuntimeBackend({ host, retryCeilingMs: 5 })
  server = startServer({ appDir: root, backend, token: TOKEN })
  scriptedBackend = new RuntimeBackend({ retryCeilingMs: 5 })
  scriptedServer = startServer({ appDir: root, backend: scriptedBackend, token: TOKEN })
})

afterAll(() => {
  backend.close()
  void server.stop(true)
  scriptedBackend.close()
  void scriptedServer.stop(true)
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(stub.root, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

function post(path: string, body: unknown, headers: Record<string, string> = HEADERS) {
  return fetch(new URL(path, server.url), {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function sessionOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  if (!isRecord(body) || !isRecord(body.session)) {
    throw new Error(`no session in ${JSON.stringify(body)}`)
  }
  return body.session
}

async function newSession(extra: Record<string, unknown> = {}): Promise<string> {
  const response = await post("/api/sessions", { model: stub.plainModelId, ...extra })
  expect(response.status).toBe(201)
  return String((await sessionOf(response)).id)
}

async function modelNow(id: string): Promise<unknown> {
  const response = await fetch(new URL(`/api/sessions/${id}`, server.url), { headers: HEADERS })
  return (await sessionOf(response)).model
}

describe("POST /api/sessions/:id/target: the token", () => {
  test("no token: 401, and the target did not change", async () => {
    const id = await newSession()
    const response = await post(
      `/api/sessions/${id}/target`,
      { model: stub.noEffortModelId },
      { "content-type": "application/json" },
    )
    expect(response.status).toBe(401)
    expect(await modelNow(id)).toBe(stub.plainModelId)
  })

  test("a wrong token: 401, it is not echoed, and the target did not change", async () => {
    const id = await newSession()
    const wrong = "wrong-token-0123456789abcdefghijklmnopq"
    const response = await post(
      `/api/sessions/${id}/target`,
      { model: stub.noEffortModelId },
      { authorization: `Bearer ${wrong}`, "content-type": "application/json" },
    )
    expect(response.status).toBe(401)
    const text = await response.text()
    expect(text).not.toContain(wrong)
    expect(text).not.toContain(TOKEN)
    expect(await modelNow(id)).toBe(stub.plainModelId)
  })

  test("the right token in the URL or in the body is not a token: 401", async () => {
    const id = await newSession()
    const noAuth = { "content-type": "application/json" }
    for (const query of [`?token=${TOKEN}`, `?access_token=${TOKEN}`, `?authorization=${TOKEN}`]) {
      const response = await post(
        `/api/sessions/${id}/target${query}`,
        { model: stub.noEffortModelId },
        noAuth,
      )
      expect(response.status).toBe(401)
    }
    const inBody = await post(
      `/api/sessions/${id}/target`,
      { model: stub.noEffortModelId, token: TOKEN },
      noAuth,
    )
    expect(inBody.status).toBe(401)
    expect(await modelNow(id)).toBe(stub.plainModelId)
  })

  test("the right token in the header: 200 with the new summary", async () => {
    const id = await newSession()
    const response = await post(`/api/sessions/${id}/target`, { model: stub.noEffortModelId })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await sessionOf(response)).toMatchObject({
      id,
      model: stub.noEffortModelId,
      providerId: "apitgt",
    })
    expect(await modelNow(id)).toBe(stub.noEffortModelId)
  })
})

describe("POST /api/sessions/:id/target: the body", () => {
  const bad: [string, unknown, string][] = [
    ["an empty body", {}, "name a value to change"],
    ["a key that is not a target value (apiKey)", { model: "x", apiKey: "sk-x" }, "unknown key"],
    ["a key that is not a target value (baseUrl)", { baseUrl: "http://evil.test" }, "unknown key"],
    ["a key that is not a target value (auth)", { auth: { type: "api-key" } }, "unknown key"],
    ["a model that is not a string", { model: 7 }, "model must be"],
    ["an empty credential name", { credentialName: "" }, "credentialName must be"],
    ["a provider that is an object", { providerId: {} }, "providerId must be"],
    ["an effort that is a number", { effort: 3 }, "effort must be"],
    ["a value that is too long", { model: "m".repeat(257) }, "model must be"],
    ["a body that is not an object", "[1]", "JSON object"],
    ["a body that is not JSON", "{", "not JSON"],
  ]
  for (const [name, body, text] of bad) {
    test(`${name}: 400, and the target did not change`, async () => {
      const id = await newSession()
      const response = await post(`/api/sessions/${id}/target`, body)
      expect(response.status).toBe(400)
      const answer = await response.text()
      expect(answer).toContain(text)
      // The answer never repeats a value of the body.
      expect(answer).not.toContain("sk-x")
      expect(answer).not.toContain("evil.test")
      expect(await modelNow(id)).toBe(stub.plainModelId)
    })
  }

  test("the status of each refusal", async () => {
    const id = await newSession()
    const status = async (body: unknown) => (await post(`/api/sessions/${id}/target`, body)).status
    expect(await status({ credentialName: "nope" })).toBe(400)
    expect(await status({ model: "no-such-model" })).toBe(400)
    expect(await status({ providerId: "other", model: "x" })).toBe(400)
    expect(await status({ effort: "max" })).toBe(400)
    expect((await post("/api/sessions/session-none/target", { effort: "low" })).status).toBe(404)
    const get = await fetch(new URL(`/api/sessions/${id}/target`, server.url), { headers: HEADERS })
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("POST")
    expect(await modelNow(id)).toBe(stub.plainModelId)
  })

  test("a stored credential by name, an effort, and null for the model default", async () => {
    const id = await newSession()
    const named = await sessionOf(
      await post(`/api/sessions/${id}/target`, { credentialName: "second", effort: "high" }),
    )
    expect(named).toMatchObject({ credentialName: "second", effort: "high" })
    const back = await sessionOf(await post(`/api/sessions/${id}/target`, { effort: null }))
    expect(Object.keys(back)).not.toContain("effort")
  })

  test("scripted mode: 400, a scripted session has no target", async () => {
    const created = await fetch(new URL("/api/sessions", scriptedServer.url), {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    })
    const id = String((await sessionOf(created)).id)
    const response = await fetch(new URL(`/api/sessions/${id}/target`, scriptedServer.url), {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ model: "x" }),
    })
    expect(response.status).toBe(400)
  })
})

describe("effort", () => {
  test("POST /api/sessions takes an effort of the model, and the request has it", async () => {
    const id = await newSession({ effort: "high" })
    const before = readRecordedRequests(stub).length
    const turn = await post(`/api/sessions/${id}/messages`, { text: "go" })
    await turn.text()
    expect(
      readRecordedRequests(stub)
        .slice(before)
        .map((r) => r.effort),
    ).toEqual(["high"])
  })

  test("POST /api/sessions refuses an effort that the model does not have: 400", async () => {
    const response = await post("/api/sessions", { model: stub.plainModelId, effort: "max" })
    expect(response.status).toBe(400)
    const error: unknown = await response.json()
    expect(isRecord(error) && error.error).toBe(
      `model "${stub.plainModelId}" does not have effort "max". Levels: low, high`,
    )
    const notString = await post("/api/sessions", { model: stub.plainModelId, effort: 2 })
    expect(notString.status).toBe(400)
  })

  test("GET /api/models gives the effort levels of each model", async () => {
    const response = await fetch(new URL("/api/models", server.url), { headers: HEADERS })
    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("no models")
    const levels = new Map<string, unknown>()
    for (const model of body.models) {
      if (!isRecord(model) || !isRecord(model.capabilities)) continue
      const { effort } = model.capabilities
      if (isRecord(effort)) levels.set(String(model.id), effort.levels)
    }
    expect(levels.get(stub.plainModelId)).toEqual(["low", "high"])
    expect(levels.get(stub.noEffortModelId)).toEqual([])
  })
})
