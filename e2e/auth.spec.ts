/** The token in the browser (S57): no token, a wrong token, and where the token goes. */

import { expect, test } from "@playwright/test"

import { newSession, openApp, send, token, turnDone } from "./helpers.ts"

test("without a token the app calls no API and says how to get one", async ({ page }) => {
  const apiCalls: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api")) apiCalls.push(request.url())
  })
  await page.goto("/")
  await expect(page.getByTestId("locked")).toBeVisible()
  expect(apiCalls).toEqual([])
})

test("a wrong token is refused and the app locks", async ({ page }) => {
  await page.goto(`/#token=${"x".repeat(43)}`)
  await expect(page.getByTestId("locked")).toBeVisible()
})

test("the token travels only in the Authorization header", async ({ page }) => {
  const secret = token()
  const leaks: string[] = []
  let authorized = 0
  page.on("request", (request) => {
    if (request.url().includes(secret)) leaks.push(request.url())
    if (request.headers().authorization === `Bearer ${secret}`) authorized++
  })
  await openApp(page)
  // The fragment is removed from the address bar once the app has read it.
  await expect.poll(() => new URL(page.url()).hash).toBe("")
  await newSession(page)
  await send(page, "hello")
  await turnDone(page)
  await page.reload()
  await expect(page.getByTestId("user-text")).toHaveText("hello")
  expect(leaks).toEqual([])
  expect(authorized).toBeGreaterThan(3)
})
