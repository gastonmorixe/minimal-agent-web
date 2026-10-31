/** Shared steps for the e2e specs. */

import { expect, type Page } from "@playwright/test"

/** The token the server was started with (see `playwright.config.ts`). */
export function token(): string {
  const value = process.env.MA_WEB_TOKEN
  if (value === undefined) throw new Error("MA_WEB_TOKEN is not set")
  return value
}

/** Open the app with the token in the fragment, as the printed URL does. */
export async function openApp(page: Page, path = "/"): Promise<void> {
  await page.goto(`${path}#token=${token()}`)
}

/** Create a session from the sidebar and wait for its page. Returns its id. */
export async function newSession(page: Page): Promise<string> {
  await page.getByTestId("new-session").click()
  await expect(page).toHaveURL(/\/sessions\/session-\d+$/u)
  return new URL(page.url()).pathname.split("/")[2] ?? ""
}

/** Type a message and send it. */
export async function send(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).fill(text)
  await page.getByRole("button", { name: "Send" }).click()
}

/** Wait until the current turn is over (Send is back). */
export async function turnDone(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 20_000 })
}
