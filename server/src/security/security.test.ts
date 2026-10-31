import { describe, expect, test } from "bun:test"

import { checkBindHost, checkToken, createToken, isAuthorized, isLoopbackHost } from "./security.ts"

function request(authorization?: string): Request {
  return new Request(
    "http://127.0.0.1/api/sessions",
    authorization === undefined ? {} : { headers: { authorization } },
  )
}

describe("createToken", () => {
  test("makes 256-bit base64url tokens that differ every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createToken()))
    expect(tokens.size).toBe(50)
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(() => checkToken(token)).not.toThrow()
    }
  })
})

describe("isAuthorized", () => {
  const token = createToken()

  test("accepts exactly the bearer token", () => {
    expect(isAuthorized(request(`Bearer ${token}`), token)).toBe(true)
  })

  test("refuses a missing, wrong, or malformed header", () => {
    expect(isAuthorized(request(), token)).toBe(false)
    expect(isAuthorized(request(`Bearer ${createToken()}`), token)).toBe(false)
    expect(isAuthorized(request(`Bearer ${token.slice(1)}`), token)).toBe(false)
    expect(isAuthorized(request(`bearer${token}`), token)).toBe(false)
    expect(isAuthorized(request(`Token ${token}`), token)).toBe(false)
    expect(isAuthorized(request(`Bearer  ${token}`), token)).toBe(false)
  })
})

describe("bind host", () => {
  test("knows the loopback forms", () => {
    for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    for (const host of [
      "0.0.0.0",
      "::",
      "10.0.0.1",
      "128.0.0.1",
      "127.0.0.256",
      "localhost.evil",
    ]) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })

  test("refuses a remote host unless allowed", () => {
    expect(() => checkBindHost("0.0.0.0", false)).toThrow("MA_WEB_ALLOW_REMOTE=1")
    expect(() => checkBindHost("0.0.0.0", true)).not.toThrow()
    expect(() => checkBindHost("127.0.0.1", false)).not.toThrow()
  })
})
