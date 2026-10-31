/** The chat (S55, updated for S53) end to end: streamed text, reasoning, retry, a permanent failure, Stop, reload. */

import { expect, test } from "@playwright/test"

import { newSession, openApp, send, turnDone } from "./helpers.ts"

test.beforeEach(async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId("transport-banner")).toBeVisible()
})

test("streams a text turn", async ({ page }) => {
  await newSession(page)
  // Record every length the reply text has while it streams.
  await page.evaluate(() => {
    const lengths: number[] = []
    Object.assign(window, { replyLengths: lengths })
    new MutationObserver(() => {
      const reply = document.querySelector('[data-testid="reply-text"]')
      if (reply?.textContent) lengths.push(reply.textContent.length)
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await send(page, "hello there")
  await expect(page.getByTestId("user-text")).toHaveText("hello there")
  await expect(page.getByTestId("reply-text")).toContainText('You wrote: "hello there"')
  await turnDone(page)
  const lengths = await page.evaluate(() =>
    "replyLengths" in window && Array.isArray(window.replyLengths) ? window.replyLengths : [],
  )
  expect(new Set(lengths).size).toBeGreaterThan(3)
  await expect(page.getByTestId("context")).toContainText("% context")
  await expect(page.getByTestId("session-title")).toHaveText("hello there")
})

test("shows reasoning, then the reply", async ({ page }) => {
  await newSession(page)
  await send(page, "think it over please")
  const reasoning = page.getByTestId("reasoning")
  await expect(reasoning).toBeVisible()
  await expect(page.getByTestId("reply-text")).toContainText("short answer")
  await turnDone(page)
  await reasoning.click()
  await expect(page.getByText("The scripted transport has no model")).toBeVisible()
})

test("a retry turn really retries, then replies", async ({ page }) => {
  await newSession(page)
  await send(page, "please retry this")
  await expect(page.getByTestId("status-line")).toContainText("Retrying")
  await expect(page.getByTestId("reply-text")).toContainText("scripted retries")
  await turnDone(page)
})

test("a permanent failure shows the error and pauses the run", async ({ page }) => {
  await newSession(page)
  await send(page, "this should fail")
  await expect(page.getByTestId("chat-error")).toContainText("scripted permanent failure")
  await turnDone(page)
})

test("Stop aborts a long run on the server", async ({ page }) => {
  await newSession(page)
  await send(page, "a long run please")
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
  await page.getByRole("button", { name: "Stop" }).click()
  await turnDone(page)
  await page.getByRole("tab", { name: "Trace" }).click()
  await expect(page.getByTestId("trace-run")).toHaveAttribute("data-outcome", "aborted")
})

test("the chat history survives a reload", async ({ page }) => {
  await newSession(page)
  await send(page, "hello again")
  await expect(page.getByTestId("reply-text")).toContainText('You wrote: "hello again"')
  await turnDone(page)
  await page.reload()
  await expect(page.getByTestId("user-text")).toHaveText("hello again")
  await expect(page.getByTestId("reply-text")).toContainText('You wrote: "hello again"')
})
