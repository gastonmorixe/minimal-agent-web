/**
 * The live session id set of {@link RuntimeBackend}.
 *
 * The host boot reads this set as its `isOwnedSession` rule (`main.ts`), so a
 * plugin with `sessions:files` or `sessions:meta` can touch only a session of
 * this process. The test runs in scripted mode: it needs no provider.
 *
 * @module backend/runtime-backend.live-ids.test
 */

import { describe, expect, test } from "bun:test"

import { RuntimeBackend } from "./runtime-backend.ts"

describe("RuntimeBackend live session ids", () => {
  test("each new session id goes into the given set", async () => {
    const live = new Set<string>()
    const backend = new RuntimeBackend({ liveSessionIds: live })
    try {
      const a = await backend.createSession({})
      const b = await backend.createSession({})
      expect([...live].sort()).toEqual([a.id, b.id].sort())
    } finally {
      backend.close()
    }
  })

  test("close() clears the set, so no old id stays owned", async () => {
    const live = new Set<string>()
    const backend = new RuntimeBackend({ liveSessionIds: live })
    await backend.createSession({})
    expect(live.size).toBe(1)
    backend.close()
    expect(live.size).toBe(0)
  })

  test("without the option, the backend keeps a private set", async () => {
    const backend = new RuntimeBackend()
    try {
      const summary = await backend.createSession({})
      expect(summary.id.length).toBeGreaterThan(0)
    } finally {
      backend.close()
    }
  })
})
