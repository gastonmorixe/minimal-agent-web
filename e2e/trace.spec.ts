/** The trace view (S56) end to end: live log, reload-resume, waits, diagnostics, usage. */

import { expect, type Page, test } from "@playwright/test"

import { newSession, openApp, send, turnDone } from "./helpers.ts"

async function counts(page: Page): Promise<{ entries: number; lastSeq: number }> {
  const count = page.getByTestId("trace-count")
  return {
    entries: Number(await count.getAttribute("data-entries")),
    lastSeq: Number(await count.getAttribute("data-last-seq")),
  }
}

test("the trace view replays the log after a reload and keeps streaming live", async ({ page }) => {
  await openApp(page)
  await newSession(page)
  await send(page, "a long run please")
  await page.getByRole("tab", { name: "Trace" }).click()
  await expect(page).toHaveURL(/\/trace$/u)
  await expect
    .poll(async () => (await counts(page)).entries, { timeout: 10_000 })
    .toBeGreaterThan(30)
  const before = await counts(page)

  await page.reload()
  await expect(page).toHaveURL(/\/trace$/u)
  // The replay brings back at least what was there, and the run is still going.
  await expect.poll(async () => (await counts(page)).entries).toBeGreaterThanOrEqual(before.entries)
  await expect(page.getByTestId("trace-run")).toHaveAttribute("data-outcome", "running")
  await expect(page.getByTestId("trace-state")).toHaveText("live")

  // It keeps streaming live entries until the run ends.
  await expect(page.getByTestId("trace-run")).toHaveAttribute("data-outcome", "completed", {
    timeout: 20_000,
  })
  const after = await counts(page)
  expect(after.entries).toBeGreaterThan(before.entries)
  // Seqs start at 0 and have no gap and no duplicate.
  expect(after.entries).toBe(after.lastSeq + 1)
  await expect(page.getByTestId("trace-round")).toHaveCount(4)
  await expect(page.getByTestId("trace-tool")).toHaveCount(3)
  await expect(page.getByTestId("trace-tool").first()).toContainText("Ran Grep pattern-1")
})

test("retries and quota waits show in the timeline, diagnostics filter by severity", async ({
  page,
}) => {
  await openApp(page)
  await newSession(page)
  await send(page, "retry until it works")
  await turnDone(page)
  await page.getByRole("tab", { name: "Trace" }).click()
  const waits = page.getByTestId("trace-wait")
  await expect(waits.filter({ hasText: "Retry after attempt 1 (overloaded)" })).toBeVisible()
  await expect(waits.filter({ hasText: "Retry after attempt 2 (overloaded)" })).toBeVisible()
  await expect(waits.filter({ hasText: "Quota fake 100/100" })).toBeVisible()
  await expect(page.locator('[data-testid="trace-wait"][data-kind="quota"]')).toHaveCount(2)

  await page.getByRole("tab", { name: /Diagnostics/u }).click()
  const all = await page.getByTestId("diagnostic").count()
  expect(all).toBeGreaterThan(3)
  await page.getByTestId("severity-filter").click()
  await page.getByRole("option", { name: "warning and worse" }).click()
  await expect(page.getByTestId("diagnostic")).toHaveCount(2)
  await expect(page.getByTestId("diagnostic").first()).toContainText("transport.retry")

  await page.getByRole("tab", { name: "Token usage" }).click()
  await expect(page.getByTestId("usage-input")).toBeVisible()
  await expect(page.getByTestId("usage-table").locator("tbody tr")).toHaveCount(1)
})
