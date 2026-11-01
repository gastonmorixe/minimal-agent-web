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
 * @module backend/stub-provider.fixture
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
}

/** Options for {@link writeStubProviderHome}. */
export interface StubProviderOptions {
  /** Declare `anonymousAuth`. Default `true`. With `false`, `host.resolveAuth` fails. */
  anonymousAuth?: boolean
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
  const anonymousAuth =
    options.anonymousAuth === false ? null : { kind: "api-key" as const, key: `anon-key-${id}` }
  writeFileSync(readPath, `${fileText}\n`)
  writeFileSync(
    join(pluginDir, "provider.json"),
    JSON.stringify({ id, entry: "./index.ts", export: "providerPlugin" }),
  )
  writeFileSync(
    join(pluginDir, "index.ts"),
    stubEntry({ id, modelId, readPath, answerText, authLog, anonymousAuth }),
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
  }
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
}

/** Source of the stub provider entry file. */
function stubEntry(input: StubEntryInput): string {
  const { id, modelId, readPath, answerText, authLog, anonymousAuth } = input
  const q = (value: unknown) => JSON.stringify(value)
  const anonymous = anonymousAuth === null ? "" : `anonymousAuth: () => (${q(anonymousAuth)}),`
  return `
import { appendFileSync } from "node:fs"

const usage = { inputTokens: 10, outputTokens: 5 }

async function* run(req, _model, ctx) {
  appendFileSync(${q(authLog)}, JSON.stringify(ctx.auth) + "\\n")
  const hasResult = JSON.stringify(req.messages).includes("tool_result")
  yield { type: "message_start", messageId: "stub-msg", modelId: req.modelId, initialUsage: usage }
  if (hasResult) {
    yield { type: "text_start", index: 0 }
    yield { type: "text_delta", index: 0, text: ${q(answerText)} }
    yield { type: "text_stop", index: 0 }
    yield { type: "message_delta", stopReason: "end_turn", usage }
  } else {
    const input = { file_path: ${q(readPath)} }
    yield { type: "tool_use_start", index: 0, id: "toolu_stub_1", name: "Read" }
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
      pricing: { inputUSD: 1, outputUSD: 2, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
    })
  },
}
`
}
