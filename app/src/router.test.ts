import { expect, test } from "bun:test"

import { parseRoute, routePath } from "./router.ts"

test("parses and builds routes", () => {
  expect(parseRoute("/")).toEqual({ name: "home" })
  expect(parseRoute("/sessions/fake-1")).toEqual({ name: "session", id: "fake-1", view: "chat" })
  expect(parseRoute("/sessions/fake-1/trace")).toEqual({
    name: "session",
    id: "fake-1",
    view: "trace",
  })
  expect(parseRoute("/sessions/a%20b/")).toEqual({ name: "session", id: "a b", view: "chat" })
  expect(parseRoute("/sessions/%E0")).toEqual({ name: "home" })
  expect(parseRoute("/other")).toEqual({ name: "home" })
  expect(routePath({ name: "session", id: "a b", view: "trace" })).toBe("/sessions/a%20b/trace")
  expect(routePath({ name: "home" })).toBe("/")
})
