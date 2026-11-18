/**
 * Test fixture: a stub provider plugin in a temp agent home.
 *
 * {@link writeStubProviderHome} writes `<home>/plugins/llm-<id>/` with a
 * `provider.json` and an entry file. `bootHost` discovers it like any real
 * provider plugin. The stub makes no network call:
 *
 * - With no `tool_result` in the request, it asks for the core `Read` tool
 *   on {@link StubProviderHome.readPath}.
 * - With a `tool_result` in the request, it answers with plain text.
 *
 * By default the stub declares `anonymousAuth`, so `host.resolveAuth` works
 * with no auth file. With `anonymousAuth: false` it declares none, so
 * `host.resolveAuth` fails (the 503 path).
 *
 * On each request, the stub appends the auth it gets (`ctx.auth`) as one
 * JSON line to {@link StubProviderHome.authLog}. Read it with
 * {@link readRecordedAuth}. A test uses it to prove which credentials reach
 * the provider.
 *
 * It also appends the model, the effort and the auth of each request to
 * {@link StubProviderHome.requestLog}. Read it with
 * {@link readRecordedRequests}. A test uses it to prove which target a
 * request of a session had.
 *
 * With `targetModels: true`, the stub registers three more models, for the
 * tests of a target change:
 *
 * - {@link StubProviderHome.plainModelId}: answers with plain text, with no
 *   tool call. Effort levels `low` and `high`, and its own context window.
 * - {@link StubProviderHome.limitedModelId}: each request fails with a
 *   transient error that has a `Retry-After` of one hour. So a turn on it
 *   waits, as a turn on a credential with a full quota does.
 * - {@link StubProviderHome.noEffortModelId}: plain text, no effort levels.
 *
 * @module backend/stub-provider.fixture
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** What {@link writeStubProviderHome} made. */
export interface StubProviderHome {
  /** Temp root. Remove it after the test. */
  root: string
  /** Agent home with `plugins/llm-<id>`. Pass it to `bootHost` as `home`. */
  home: string
  /** An empty dir, for the plugin roots that must hold no plugin. */
  emptyDir: string
  /** Provider id. */
  providerId: string
  /** Model id the stub registers. */
  modelId: string
  /** Context window the stub registers for the model. */
  contextWindow: number
  /** File the stub asks the `Read` tool to read. */
  readPath: string
  /** Text in {@link readPath}. */
  fileText: string
  /** Text of the final answer. */
  answerText: string
  /** File the stub appends the auth of each request to, one JSON line each. */
  authLog: string
  /** The auth `anonymousAuth` returns, or `null` when the stub declares none. */
  anonymousAuth: { kind: "api-key"; key: string } | null
  /** File the stub appends `{ modelId, effort, auth }` of each request to, one JSON line each. */
  requestLog: string
  /** With `targetModels`: a model that answers with plain text. Levels `low`, `high`. */
  plainModelId: string
  /** With `targetModels`: a model whose requests fail with a `Retry-After` of one hour. */
  limitedModelId: string
  /** With `targetModels`: a plain-text model with no effort levels. */
  noEffortModelId: string
}

/** Context window of {@link StubProviderHome.plainModelId}. Not the one of the first model. */
export const STUB_PLAIN_CONTEXT_WINDOW = 54_321

/** The wait that {@link StubProviderHome.limitedModelId} asks for, in ms. */
export const STUB_LIMITED_RETRY_AFTER_MS = 3_600_000

/** Options for {@link writeStubProviderHome}. */
export interface StubProviderOptions {
  /** Declare `anonymousAuth`. Default `true`. With `false`, `host.resolveAuth` fails. */
  anonymousAuth?: boolean
  /** Register the three models for the tests of a target change. Default `false`. */
  targetModels?: boolean
  /** The tool that the first answer calls, with no input. Default: `Read` of {@link StubProviderHome.readPath}. */
  toolName?: string
}

/**
 * The `bootHost` options that read only the stub home: the agent home and
 * its `plugins` dir as the one user root. No `pluginSync`, so no clone.
 */
export function stubBootOptions(stub: StubProviderHome): {
  home: string
  pluginRoots: { user: string[]; project: string[] }
  model: string
} {
  return {
    home: stub.home,
    pluginRoots: { user: [join(stub.home, "plugins")], project: [stub.emptyDir] },
    model: stub.modelId,
  }
}

/** Context window the stub model registers. Not a common default, so a test can see it. */
export const STUB_CONTEXT_WINDOW = 123_456

/**
 * Write a stub provider plugin into a new temp agent home.
 *
 * @param id - Provider id. Use a new id per test file: the model registry is process-wide.
 */
export function writeStubProviderHome(
  id: string,
  options: StubProviderOptions = {},
): StubProviderHome {
  const root = mkdtempSync(join(tmpdir(), `ma-web-${id}-`))
  const home = join(root, "home")
  const emptyDir = join(root, "empty")
  const pluginDir = join(home, "plugins", `llm-${id}`)
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(emptyDir, { recursive: true })
  const modelId = `${id}-model`
  const readPath = join(root, "note.txt")
  const fileText = `stub file text for ${id}`
  const answerText = `stub answer from ${id}`
  const authLog = join(root, "auth.jsonl")
  const requestLog = join(root, "requests.jsonl")
  const plainModelId = `${id}-plain`
  const limitedModelId = `${id}-limited`
  const noEffortModelId = `${id}-noeffort`
  const anonymousAuth =
    options.anonymousAuth === false ? null : { kind: "api-key" as const, key: `anon-key-${id}` }
  writeFileSync(readPath, `${fileText}\n`)
  writeFileSync(
    join(pluginDir, "provider.json"),
    JSON.stringify({ id, entry: "./index.ts", export: "providerPlugin" }),
  )
  writeFileSync(
    join(pluginDir, "index.ts"),
    stubEntry({
      id,
      modelId,
      readPath,
      answerText,
      authLog,
      anonymousAuth,
      requestLog,
      targetModels:
        options.targetModels === true ? { plainModelId, limitedModelId, noEffortModelId } : null,
      toolName: options.toolName ?? null,
    }),
  )
  return {
    root,
    home,
    emptyDir,
    providerId: id,
    modelId,
    contextWindow: STUB_CONTEXT_WINDOW,
    readPath,
    fileText,
    answerText,
    authLog,
    anonymousAuth,
    requestLog,
    plainModelId,
    limitedModelId,
    noEffortModelId,
  }
}

/** One request that the stub got. */
export interface RecordedRequest {
  modelId: string
  /** Absent for the model default. */
  effort?: string
  auth: unknown
}

/** Every request the stub got so far, oldest first. */
export function readRecordedRequests(stub: StubProviderHome): RecordedRequest[] {
  if (!existsSync(stub.requestLog)) return []
  const requests: RecordedRequest[] = []
  for (const line of readFileSync(stub.requestLog, "utf8").split("\n")) {
    if (line.length === 0) continue
    const value: unknown = JSON.parse(line)
    if (typeof value !== "object" || value === null) continue
    const modelId: unknown = Reflect.get(value, "modelId")
    const effort: unknown = Reflect.get(value, "effort")
    if (typeof modelId !== "string") continue
    requests.push({
      modelId,
      ...(typeof effort === "string" ? { effort } : {}),
      auth: Reflect.get(value, "auth"),
    })
  }
  return requests
}

/** Every auth the stub got so far, oldest first. */
export function readRecordedAuth(stub: StubProviderHome): unknown[] {
  if (!existsSync(stub.authLog)) return []
  return readFileSync(stub.authLog, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line))
}

/** What {@link stubEntry} writes into the entry file. */
interface StubEntryInput {
  id: string
  modelId: string
  readPath: string
  answerText: string
  authLog: string
  anonymousAuth: StubProviderHome["anonymousAuth"]
  requestLog: string
  targetModels: { plainModelId: string; limitedModelId: string; noEffortModelId: string } | null
  toolName: string | null
}

/** Source of the stub provider entry file. */
function stubEntry(input: StubEntryInput): string {
  const { id, modelId, readPath, answerText, authLog, anonymousAuth, requestLog } = input
  const q = (value: unknown) => JSON.stringify(value)
  const anonymous = anonymousAuth === null ? "" : `anonymousAuth: () => (${q(anonymousAuth)}),`
  const extra = input.targetModels
  const pricing =
    "{ inputUSD: 1, outputUSD: 2, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 }"
  const registerExtra =
    extra === null
      ? ""
      : `
    const more = [
      [${q(extra.plainModelId)}, ${STUB_PLAIN_CONTEXT_WINDOW}, ["low", "high"]],
      [${q(extra.limitedModelId)}, ${STUB_CONTEXT_WINDOW}, ["low", "high"]],
      [${q(extra.noEffortModelId)}, ${STUB_CONTEXT_WINDOW}, []],
    ]
    for (const [modelId, contextWindow, levels] of more) {
      ctx.models.register({
        id: modelId,
        providerId: ${q(id)},
        surfaceId: "stub-surface",
        displayName: modelId + " display",
        capabilities: {
          contextWindow,
          maxOutputTokens: 1000,
          effort: { levels, default: levels[0] ?? "medium" },
        },
        pricing: ${pricing},
      })
    }`
  return `
import { appendFileSync } from "node:fs"

const usage = { inputTokens: 10, outputTokens: 5 }

const PLAIN = ${q(extra === null ? [] : [extra.plainModelId, extra.noEffortModelId])}
const LIMITED = ${q(extra?.limitedModelId ?? "")}

async function* run(req, _model, ctx) {
  appendFileSync(${q(authLog)}, JSON.stringify(ctx.auth) + "\\n")
  appendFileSync(
    ${q(requestLog)},
    JSON.stringify({ modelId: req.modelId, effort: req.effort, auth: ctx.auth }) + "\\n",
  )
  if (LIMITED !== "" && req.modelId === LIMITED) {
    // As a 429 with Retry-After: a transient error with a wait of one hour.
    throw Object.assign(new Error("stub: the quota of this model is full"), {
      errorClass: "transient",
      streamErrorType: "rate_limit_error",
      retryAfterMs: ${STUB_LIMITED_RETRY_AFTER_MS},
    })
  }
  const hasResult = JSON.stringify(req.messages).includes("tool_result")
  yield { type: "message_start", messageId: "stub-msg", modelId: req.modelId, initialUsage: usage }
  if (hasResult || PLAIN.includes(req.modelId)) {
    yield { type: "text_start", index: 0 }
    yield { type: "text_delta", index: 0, text: ${q(answerText)} }
    yield { type: "text_stop", index: 0 }
    yield { type: "message_delta", stopReason: "end_turn", usage }
  } else {
    const input = ${input.toolName === null ? `{ file_path: ${q(readPath)} }` : "{}"}
    yield { type: "tool_use_start", index: 0, id: "toolu_stub_1", name: ${q(input.toolName ?? "Read")} }
    yield { type: "tool_use_input_delta", index: 0, partialJson: JSON.stringify(input) }
    yield { type: "tool_use_stop", index: 0, input }
    yield { type: "message_delta", stopReason: "tool_use", usage }
  }
  yield { type: "message_stop" }
}

export const providerPlugin = {
  id: ${q(id)},
  displayName: ${q(`${id} provider`)},
  shortCode: ${q(id.slice(0, 2))},
  ${anonymous}
  register(ctx) {
    ctx.providers.register({
      id: ${q(id)},
      displayName: ${q(id)},
      surfaces: ["stub-surface"],
      validate: () => ({ ok: true, errors: [] }),
      run,
    })
    ctx.models.register({
      id: ${q(modelId)},
      providerId: ${q(id)},
      surfaceId: "stub-surface",
      displayName: ${q(`${modelId} display`)},
      capabilities: { contextWindow: ${STUB_CONTEXT_WINDOW}, maxOutputTokens: 1000 },
      pricing: ${pricing},
    })${registerExtra}
  },
}
`
}

/** The stub text plugin package dir (every required text contract, short markers). */
export const TEXT_STUB_PLUGIN_DIR = join(import.meta.dir, "fixtures", "ma-text-stub-fixture-plugin")

/**
 * Copy the stub text plugin into `<home>/plugins`, so a boot with
 * `requiredContracts: TEXT_CONTRACTS` (the web main) passes the contract check.
 */
export function writeTextStubPlugin(home: string): void {
  cpSync(TEXT_STUB_PLUGIN_DIR, join(home, "plugins", "ma-text-stub-fixture-plugin"), {
    recursive: true,
  })
}
