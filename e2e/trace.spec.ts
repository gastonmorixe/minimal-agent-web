/** The trace view (S56, updated for S53) end to end: live log, reload-resume, waits, diagnostics, usage. */

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
  await expect.poll(async () => (await counts(page)).entries, { timeout: 5_000 }).toBeGreaterThan(3)
  const before = await counts(page)
  await expect(page.getByTestId("trace-run")).toHaveAttribute("data-outcome", "running")

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
  await expect(page.getByTestId("trace-round")).toHaveCount(1)
})

test("a retry shows in the timeline, diagnostics filter by severity", async ({ page }) => {
  await openApp(page)
  await newSession(page)
  await send(page, "please retry this one")
  await turnDone(page)
  await page.getByRole("tab", { name: "Trace" }).click()
  const waits = page.getByTestId("trace-wait")
  await expect(waits.filter({ hasText: "Retry after attempt" })).toHaveCount(2)
  await expect(page.locator('[data-testid="trace-wait"][data-kind="retry"]')).toHaveCount(2)

  await page.getByRole("tab", { name: /Diagnostics/u }).click()
  const all = await page.getByTestId("diagnostic").count()
  expect(all).toBeGreaterThan(2)
  await page.getByTestId("severity-filter").click()
  await page.getByRole("option", { name: "warning and worse" }).click()
  const warnings = await page.getByTestId("diagnostic").count()
  expect(warnings).toBeGreaterThan(0)
  expect(warnings).toBeLessThan(all)

  await page.getByRole("tab", { name: "Token usage" }).click()
  await expect(page.getByTestId("usage-input")).toBeVisible()
  await expect(page.getByTestId("usage-table").locator("tbody tr")).toHaveCount(1)
})

test("a quota wait shows in the timeline", async ({ page }) => {
  await openApp(page)
  await newSession(page)
  await send(page, "mind the quota please")
  await turnDone(page)
  await page.getByRole("tab", { name: "Trace" }).click()
  await expect(page.locator('[data-testid="trace-wait"][data-kind="quota"]')).toHaveCount(1)
  await expect(
    page.getByTestId("trace-wait").filter({ hasText: "Waiting for quota" }),
  ).toBeVisible()
})
