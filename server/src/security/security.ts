/**
 * Security of the web server (spec 4.5, S57).
 *
 * - Bind: loopback only by default. Any other address needs an explicit
 *   opt-in ({@link checkBindHost}). Remote access is out of scope for v2.
 * - Token: a random bearer token per server start ({@link createToken}).
 *   Every `/api` request must carry `Authorization: Bearer <token>`
 *   ({@link isAuthorized}). The static app needs no token: it holds no secret.
 * - The token reaches the browser only in the URL fragment the server prints
 *   at start (`http://127.0.0.1:4317/#token=...`). Browsers never send a
 *   fragment to a server, so the token is never in a request line, a server
 *   URL, or an access log. The server logs no requests and no headers.
 * - No CORS: the server sends no `Access-Control-*` header, so another origin
 *   can neither read a response nor send the header a preflight would need.
 *
 * @module security/security
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** Bytes of randomness in a token: 256 bits. */
const TOKEN_BYTES = 32

/** Shortest token {@link checkToken} accepts from configuration. */
export const MIN_TOKEN_LENGTH = 32

/** A new random token, base64url (43 characters). */
export function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url")
}

/** Throw unless `token` is long enough and URL-fragment safe. */
export function checkToken(token: string): void {
  if (token.length < MIN_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(token)) {
    throw new Error(
      `the API token must be at least ${MIN_TOKEN_LENGTH} characters of A-Z, a-z, 0-9, "-", "_"`,
    )
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

/**
 * True when the request carries `Authorization: Bearer <token>`. The compare
 * runs in constant time over SHA-256 digests, so neither the length nor the
 * content of the token leaks through timing.
 */
export function isAuthorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization")
  if (header === null) return false
  const match = /^Bearer ([^\s]+)$/u.exec(header)
  if (match?.[1] === undefined) return false
  return timingSafeEqual(digest(match[1]), digest(token))
}

/** The answer to a request without the right token. It never echoes what was sent. */
export function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "www-authenticate": 'Bearer realm="minimal-agent"' } },
  )
}

/** True for a loopback address: `localhost`, `127.0.0.0/8`, or `::1`. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  if (bare === "localhost" || bare === "::1") return true
  return /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u.test(bare)
}

/** The server refused to bind a non-loopback address. */
export class BindRefusedError extends Error {
  /** Create the error. */
  constructor(readonly host: string) {
    super(
      `refusing to bind ${host}: the web server binds loopback only. ` +
        "Set MA_WEB_ALLOW_REMOTE=1 to bind another address on purpose.",
    )
    this.name = "BindRefusedError"
  }
}

/** Throw {@link BindRefusedError} for a non-loopback host unless `allowRemote` is set. */
export function checkBindHost(host: string, allowRemote: boolean): void {
  if (!allowRemote && !isLoopbackHost(host)) throw new BindRefusedError(host)
}
