/**
 * A tiny client router over the History API. Routes:
 *
 * - `/`: no session open.
 * - `/sessions/:id`: the chat of a session.
 * - `/sessions/:id/trace`: its trace view.
 *
 * The server answers every path that is not a file with `index.html`, so a
 * reload of any route works.
 *
 * @module router
 */

import * as React from "react"

/** A parsed route. */
export type Route = { name: "home" } | { name: "session"; id: string; view: "chat" | "trace" }

/** Parse a pathname. Anything unknown is home. */
export function parseRoute(pathname: string): Route {
  const match = /^\/sessions\/([^/]+)(\/trace)?\/?$/u.exec(pathname)
  if (match?.[1] === undefined) return { name: "home" }
  let id: string
  try {
    id = decodeURIComponent(match[1])
  } catch {
    return { name: "home" }
  }
  return { name: "session", id, view: match[2] === undefined ? "chat" : "trace" }
}

/** The pathname of a route. */
export function routePath(route: Route): string {
  if (route.name === "home") return "/"
  const base = `/sessions/${encodeURIComponent(route.id)}`
  return route.view === "trace" ? `${base}/trace` : base
}

/** The current route and a function that goes to another one. */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = React.useState(() => parseRoute(window.location.pathname))
  React.useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  const navigate = React.useCallback((next: Route) => {
    window.history.pushState(null, "", routePath(next))
    setRoute(next)
  }, [])
  return [route, navigate]
}
