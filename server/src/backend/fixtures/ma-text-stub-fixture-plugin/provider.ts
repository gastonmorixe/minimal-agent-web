/**
 * Stub text for every required text contract (test fixture only). Each text
 * is a short marker, so a spawn test of the web host passes the boot contract
 * check without the first-party text plugins.
 *
 * @module backend/fixtures/ma-text-stub-fixture-plugin
 */

import manifest from "./manifest.json" with { type: "json" }

const SLOTS = ["instructions", "toolOutputConventions"] as const

/** The system prompt base provider: identity and the 2 slots. */
export default function createBase() {
  return {
    slots: SLOTS,
    identity: () => "stub identity",
    instructionParts: () => SLOTS.map((slot) => ({ slot, text: `stub ${slot}` })),
  }
}

/** Tool text: a stub description for each built-in tool. */
export function createToolText() {
  const tools = manifest.toolText[0]?.tools ?? []
  return { tools, tool: (name: string) => ({ description: `stub ${name}`, params: {} }) }
}

/** Synthetic text: the kind name as the text. */
export function createSyntheticText() {
  const kinds = manifest.syntheticText[0]?.kinds ?? []
  return { kinds, text: (kind: string) => `stub ${kind}` }
}
