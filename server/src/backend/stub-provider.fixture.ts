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
 * The stub declares `anonymousAuth`, so `host.resolveAuth` works with no
 * auth file. It never reads the credentials it gets.
 *
 * @module backend/stub-provider.fixture
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** What {@link writeStubProviderHome} made. */
export interface StubProviderHome {
  /** Temp root. Remove it after the test. */
  root: string
  /** Agent home with `plugins/llm-<id>`. Pass it to `bootHost` as `home`. */
  home: string
  /** An empty dir for `embeddedDir`, `projectDir`, and `homeDir`. */
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
}

/** Context window the stub model registers. Not a common default, so a test can see it. */
export const STUB_CONTEXT_WINDOW = 123_456

/**
 * Write a stub provider plugin into a new temp agent home.
 *
 * @param id - Provider id. Use a new id per test file: the model registry is process-wide.
 */
export function writeStubProviderHome(id: string): StubProviderHome {
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
  writeFileSync(readPath, `${fileText}\n`)
  writeFileSync(
    join(pluginDir, "provider.json"),
    JSON.stringify({ id, entry: "./index.ts", export: "providerPlugin" }),
  )
  writeFileSync(join(pluginDir, "index.ts"), stubEntry(id, modelId, readPath, answerText))
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
  }
}

/** Source of the stub provider entry file. */
function stubEntry(id: string, modelId: string, readPath: string, answerText: string): string {
  const q = (value: unknown) => JSON.stringify(value)
  return `
const usage = { inputTokens: 10, outputTokens: 5 }

async function* run(req) {
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
  anonymousAuth: () => ({ kind: "api-key", key: "stub-anonymous" }),
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
