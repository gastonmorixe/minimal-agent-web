/**
 * The API bearer token in the browser (spec 4.5, S57).
 *
 * The server prints `http://127.0.0.1:4317/#token=<token>` at start. The app
 * reads the token from the fragment once, keeps it in memory and in this
 * tab's `sessionStorage` (so a reload of the tab keeps working), and removes
 * the fragment from the address bar and the history entry.
 *
 * The token goes only into the `Authorization` header of API calls. Never
 * put it in a path, a query string, a cookie, or a log line: a fragment is
 * the one part of a URL a browser never sends to a server.
 *
 * @module api/token
 */

const STORAGE_KEY = "minimal-agent.api-token"
const FRAGMENT_KEY = "token"

let token: string | null = null

/** What {@link initToken} reads and writes. Tests pass fakes. */
export interface TokenEnvironment {
  location: Pick<Location, "hash" | "pathname" | "search">
  history: Pick<History, "replaceState" | "state">
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
}

function browserEnvironment(): TokenEnvironment {
  let storage: TokenEnvironment["storage"] = null
  try {
    storage = window.sessionStorage
  } catch {
    // Storage can be blocked. The token then lives in memory only.
  }
  return { location: window.location, history: window.history, storage }
}

/** The token from a URL fragment such as `#token=abc`, or null. */
export function tokenFromFragment(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/u, "")).get(FRAGMENT_KEY)
  return value !== null && value.length > 0 ? value : null
}

/**
 * Read the token at startup: from the fragment (then remove the fragment),
 * else from this tab's storage. Returns the token, or null when there is none.
 */
export function initToken(env: TokenEnvironment = browserEnvironment()): string | null {
  const fromFragment = tokenFromFragment(env.location.hash)
  if (fromFragment !== null) {
    token = fromFragment
    try {
      env.storage?.setItem(STORAGE_KEY, fromFragment)
    } catch {
      // Memory only.
    }
    env.history.replaceState(env.history.state, "", env.location.pathname + env.location.search)
    return token
  }
  try {
    token = env.storage?.getItem(STORAGE_KEY) ?? null
  } catch {
    token = null
  }
  return token
}

/** The token, or null before {@link initToken} found one. */
export function getToken(): string | null {
  return token
}

/** Forget the token, for example after the server answered 401 (it restarted). */
export function clearToken(
  storage: TokenEnvironment["storage"] = browserEnvironment().storage,
): void {
  token = null
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing stored.
  }
}
