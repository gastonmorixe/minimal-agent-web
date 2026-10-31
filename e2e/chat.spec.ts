/** The chat (S55) end to end: streamed text, tools, approval, Stop, reload. */

import { expect, test } from "@playwright/test"

import { newSession, openApp, send, turnDone } from "./helpers.ts"

test.beforeEach(async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId("fake-banner")).toBeVisible()
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

test("runs a tool turn and shows the tool's input, output, and duration", async ({ page }) => {
  await newSession(page)
  await send(page, "read the file with a tool")
  const tool = page.getByTestId("tool").filter({ hasText: "Read README.md" })
  await expect(tool).toContainText("Ran Read README.md")
  await expect(tool).toContainText("3 lines · 42ms")
  await expect(page.getByText("The file has three lines.")).toBeVisible()
  await turnDone(page)
  await tool.click()
  await expect(page.getByText("Nothing here is real.")).toBeVisible()
})

test("asks for approval through the Confirmation and runs the tool after Approve", async ({
  page,
}) => {
  await newSession(page)
  await send(page, "approve the delete")
  const approval = page.getByTestId("approval")
  await expect(approval).toContainText("Run Bash rm -rf dist?")
  await approval.getByRole("button", { name: "Approve" }).click()
  await expect(approval).toHaveCount(0)
  await expect(page.getByTestId("tool").filter({ hasText: "rm -rf dist" })).toContainText(
    "Ran Bash rm -rf dist",
  )
  await expect(page.getByText("Removed the dist folder.")).toBeVisible()
  await turnDone(page)
})

test("Deny keeps the tool from running", async ({ page }) => {
  await newSession(page)
  await send(page, "approve the delete")
  await page.getByTestId("approval").getByRole("button", { name: "Deny" }).click()
  await expect(page.getByTestId("tool").filter({ hasText: "rm -rf dist" })).toContainText("Denied")
  await expect(page.getByText("I left the dist folder in place.")).toBeVisible()
})

test("answers a free-form question", async ({ page }) => {
  await newSession(page)
  await send(page, "ask me a question")
  const question = page.getByTestId("question")
  await expect(question).toContainText("Which branch should I use?")
  await question.getByRole("button", { name: "dev" }).click()
  await expect(page.getByTestId("reply-text").last()).toContainText('Using the branch "dev"')
})

test("Stop aborts a long run on the server", async ({ page }) => {
  await newSession(page)
  await send(page, "a long run please")
  await expect(page.getByTestId("tool").first()).toBeVisible()
  await page.getByRole("button", { name: "Stop" }).click()
  await turnDone(page)
  await page.getByRole("tab", { name: "Trace" }).click()
  await expect(page.getByTestId("trace-run")).toHaveAttribute("data-outcome", "aborted")
})

test("the chat history survives a reload", async ({ page }) => {
  await newSession(page)
  await send(page, "read the file with a tool")
  await expect(page.getByText("The file has three lines.")).toBeVisible()
  await turnDone(page)
  await page.reload()
  await expect(page.getByTestId("user-text")).toHaveText("read the file with a tool")
  await expect(page.getByTestId("tool")).toContainText("Ran Read README.md")
  await expect(page.getByText("The file has three lines.")).toBeVisible()
})
