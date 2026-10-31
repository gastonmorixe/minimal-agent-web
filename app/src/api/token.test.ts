import { beforeEach, describe, expect, test } from "bun:test"

import {
  clearToken,
  getToken,
  initToken,
  type TokenEnvironment,
  tokenFromFragment,
} from "./token.ts"

function env(hash: string, stored: string | null = null) {
  const store = new Map<string, string>()
  if (stored !== null) store.set("minimal-agent.api-token", stored)
  const replaced: string[] = []
  const environment: TokenEnvironment = {
    location: { hash, pathname: "/sessions/fake-1", search: "?x=1" },
    history: {
      state: null,
      replaceState: (_state, _unused, url) => {
        replaced.push(String(url))
      },
    },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value)
      },
      removeItem: (key) => {
        store.delete(key)
      },
    },
  }
  return { environment, store, replaced }
}

beforeEach(() => {
  clearToken(null)
})

describe("tokenFromFragment", () => {
  test("reads token= from the fragment", () => {
    expect(tokenFromFragment("#token=abc_DEF-123")).toBe("abc_DEF-123")
    expect(tokenFromFragment("#other=1&token=xyz")).toBe("xyz")
    expect(tokenFromFragment("")).toBeNull()
    expect(tokenFromFragment("#token=")).toBeNull()
  })
})

describe("initToken", () => {
  test("takes the token from the fragment, stores it for the tab, and strips the fragment", () => {
    const { environment, store, replaced } = env("#token=from-url")
    expect(initToken(environment)).toBe("from-url")
    expect(getToken()).toBe("from-url")
    expect(store.get("minimal-agent.api-token")).toBe("from-url")
    // The fragment is gone; the path and query stay; the token is in neither.
    expect(replaced).toEqual(["/sessions/fake-1?x=1"])
  })

  test("falls back to the tab's storage after a reload", () => {
    const { environment, replaced } = env("", "stored")
    expect(initToken(environment)).toBe("stored")
    expect(replaced).toEqual([])
  })

  test("prefers a new fragment over a stored token", () => {
    const { environment } = env("#token=new", "old")
    expect(initToken(environment)).toBe("new")
  })

  test("works without storage and finds nothing without a fragment", () => {
    const { environment } = env("")
    expect(initToken({ ...environment, storage: null })).toBeNull()
    expect(initToken({ ...env("#token=mem").environment, storage: null })).toBe("mem")
  })

  test("clearToken forgets it in memory and storage", () => {
    const { environment, store } = env("#token=t")
    initToken(environment)
    clearToken(environment.storage)
    expect(getToken()).toBeNull()
    expect(store.size).toBe(0)
  })
})
