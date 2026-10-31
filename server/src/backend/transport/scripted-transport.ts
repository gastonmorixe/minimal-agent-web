/**
 * A deterministic, scripted model transport (S53).
 *
 * Core's `createRuntime` builds a pure runtime with no provider wired in: a
 * real model call needs a provider plugin (`@minimal-agent/core/plugin-api/*`
 * implementations living in the sibling `minimal-agent-plugins` repo) loaded
 * by a host, the way the CLI's boot sequence does
 * (`src/host/startup/provider-discovery-boot.ts` in core, host-only). This
 * server has one runtime dependency, `@minimal-agent/core` — adding the
 * plugins repo as a second one, and reimplementing provider discovery, is
 * out of scope for S53 (see `runtime-backend.ts`'s module doc for the full
 * scope note).
 *
 * Instead, every session's `AgentCore` gets this transport as its `sendFn`
 * (`AgentCoreConfig.sendFn`, the same seam core's own tests use to avoid a
 * real network call). It picks a scripted reply by a keyword in the
 * person's last message (same idea as a canned demo, but it runs through
 * the REAL `AgentCore` loop end to end: real round/item events, real
 * `turn_completed` usage from the `StreamedResponse` it returns, and — for
 * the retry and permanent-error scripts — the REAL retry/backoff and
 * permanent-pause machinery in `src/sdk/stop-policy.ts` and
 * `src/sdk/run-recovery.ts`, by throwing an error tagged with
 * `tagUpstreamError` from `@minimal-agent/core/plugin-api/llm/errors`, the
 * documented way a provider adapter classifies a failure for the loop.
 *
 * `auth` is required by `AgentCoreConfig` but unused here (this transport
 * never calls a provider), so `runtime-backend.ts` passes a placeholder.
 *
 * The chosen type is derived from core's own `SessionOptions["sendFn"]`
 * (`@minimal-agent/core`'s root export) rather than hand-copied, since core
 * does not export `TransportFn` / `SendOptions` / `StreamedResponse` by
 * name (they are reachable only through that field's type position, via
 * `./sdk/ports`). Deriving the parameter and return shapes this way means a
 * change to the real signature fails typecheck here, instead of silently
 * drifting the way `core-mirror/` once did.
 *
 * @module backend/transport/scripted-transport
 */

import type { SessionOptions } from "@minimal-agent/core"
import { tagUpstreamError } from "@minimal-agent/core/plugin-api/llm/errors"

/** The transport function shape `AgentCoreConfig.sendFn` / `SessionOptions.sendFn` takes. */
export type ScriptedTransport = NonNullable<SessionOptions["sendFn"]>

/** The options one send gets. Derived, not hand-copied (see the module doc). */
export type ScriptedSendOptions = Parameters<ScriptedTransport>[0]

/** What one send returns once streaming ends. Derived, not hand-copied. */
export type ScriptedStreamedResponse =
  ReturnType<ScriptedTransport> extends AsyncGenerator<string, infer R, undefined> ? R : never

/** Options for {@link createScriptedTransport}. */
export interface ScriptedTransportOptions {
  /** Real time between streamed chunks and before a retry succeeds. Default 15 ms. */
  stepDelayMs?: number
}

const DEFAULT_STEP_DELAY_MS = 15
const SCRIPT_NOTE = "This reply is scripted: no model is called (see AGENTS.md, Session backend)."

/** Resolves after `ms`, or rejects with an `AbortError` at once if `signal` is already aborted. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function words(text: string): string[] {
  return text.match(/\S+\s*|\s+/gu) ?? []
}

function tokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** The text of the last user message, or "". Scripts key off this, like a canned demo would. */
function lastUserText(messages: ScriptedSendOptions["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "user") continue
    const content = message.content
    if (typeof content === "string") return content
    const text = content?.map((block) => (block.type === "text" ? block.text : "")).join("")
    return text ?? ""
  }
  return ""
}

/** Attempts seen per scenario label, for the retry script. Module state: test-only, serial use. */
const retryAttempts = new Map<string, number>()

async function* textReply(
  text: string,
  opts: ScriptedSendOptions,
  stepDelayMs: number,
): AsyncGenerator<string, ScriptedStreamedResponse, undefined> {
  for (const piece of words(text)) {
    await sleep(stepDelayMs, opts.signal)
    yield piece
  }
  return {
    blocks: [{ type: "text", text }],
    text,
    stopReason: "end_turn",
    usage: { input_tokens: 40, output_tokens: tokens(text) },
  }
}

async function* thinkingThenReply(
  thinking: string,
  text: string,
  opts: ScriptedSendOptions,
  stepDelayMs: number,
): AsyncGenerator<string, ScriptedStreamedResponse, undefined> {
  await opts.onThinkingStart?.()
  for (const piece of words(thinking)) {
    await sleep(stepDelayMs, opts.signal)
    await opts.onThinkingDelta?.(piece)
  }
  await opts.onThinkingStop?.()
  for (const piece of words(text)) {
    await sleep(stepDelayMs, opts.signal)
    yield piece
  }
  return {
    blocks: [
      { type: "thinking", thinking, signature: "" },
      { type: "text", text },
    ],
    text,
    stopReason: "end_turn",
    usage: { input_tokens: 60, output_tokens: tokens(thinking) + tokens(text) },
  }
}

/**
 * Create the scripted transport. Keywords in the person's message (the
 * empty-chat hint list in the app lists these):
 *
 * - default (no keyword): a short text reply.
 * - `think`: a reasoning block, then a text reply.
 * - `retry`: two transient failures (`status` phase `retrying`), then a
 *   reply — the real retry/backoff loop runs.
 * - `quota`: one recoverable quota failure with a near-future reset
 *   (`status` phase `waiting_for_quota`), then a reply.
 * - `fail`: a permanent failure — the run pauses (`outcome: "waiting"`),
 *   exactly as a revoked credential would.
 * - `long`: a slow reply, several seconds of streamed words, for exercising
 *   Stop / abort.
 */
export function createScriptedTransport(options: ScriptedTransportOptions = {}): ScriptedTransport {
  const stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS

  return async function* scriptedTransport(
    opts: ScriptedSendOptions,
  ): AsyncGenerator<string, ScriptedStreamedResponse, undefined> {
    const text = lastUserText(opts.messages).toLowerCase()

    if (/\bretry\b/u.test(text)) {
      const seen = (retryAttempts.get("retry") ?? 0) + 1
      retryAttempts.set("retry", seen)
      if (seen <= 2) {
        throw tagUpstreamError(new Error(`scripted transient failure, attempt ${seen}`), {
          errorClass: "transient",
        })
      }
      retryAttempts.delete("retry")
      return yield* textReply(
        `${SCRIPT_NOTE} Answered after ${seen - 1} scripted retries.`,
        opts,
        stepDelayMs,
      )
    }

    if (/\bquota\b/u.test(text)) {
      const seen = (retryAttempts.get("quota") ?? 0) + 1
      retryAttempts.set("quota", seen)
      if (seen === 1) {
        throw tagUpstreamError(new Error("scripted quota exhaustion"), {
          errorClass: "recoverable",
          recovery: "wait_for_quota",
          resetAt: Date.now() + 2 * stepDelayMs,
        })
      }
      retryAttempts.delete("quota")
      return yield* textReply(
        `${SCRIPT_NOTE} Answered after the scripted quota wait.`,
        opts,
        stepDelayMs,
      )
    }

    if (/\bfail\b/u.test(text)) {
      throw tagUpstreamError(new Error("scripted permanent failure"), { errorClass: "permanent" })
    }

    if (/\blong\b/u.test(text)) {
      // Enough words that a reload mid-stream reliably lands before it ends.
      const long = Array.from({ length: 150 }, (_, index) => `word${index + 1}`).join(" ")
      return yield* textReply(`${SCRIPT_NOTE} ${long}.`, opts, stepDelayMs)
    }

    if (/\bthink\b/u.test(text)) {
      return yield* thinkingThenReply(
        "The scripted transport has no model: this reasoning is scripted too.",
        `${SCRIPT_NOTE} Here is a short answer after some scripted thinking.`,
        opts,
        stepDelayMs,
      )
    }

    const reply = `${SCRIPT_NOTE} You wrote: "${lastUserText(opts.messages).trim().slice(0, 200)}".`
    return yield* textReply(reply, opts, stepDelayMs)
  }
}
