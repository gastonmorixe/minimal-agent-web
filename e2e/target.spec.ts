/**
 * The target control of an open session, end to end, on the provider-mode
 * server (a stub provider plugin, no network): a model change during a wait
 * of one hour, an effort change, and that an other session keeps its target.
 *
 * The stub has no stored credential (it declares an anonymous auth), and the
 * new-session panel needs a credential. So each test makes its session with
 * the API, then opens its page.
 */

import { type APIRequestContext, expect, type Page, test } from "@playwright/test"

import { providerUrl, send, token, turnDone } from "./helpers.ts"

const PLAIN = "e2e-plain"
const LIMITED = "e2e-limited"

const headers = () => ({ authorization: `Bearer ${token()}` })

async function createSession(request: APIRequestContext, model: string): Promise<string> {
  const response = await request.post(`${providerUrl()}/api/sessions`, {
    headers: headers(),
    data: { model, providerId: "e2e" },
  })
  expect(response.status()).toBe(201)
  const body: unknown = await response.json()
  const session = typeof body === "object" && body !== null ? Reflect.get(body, "session") : null
  const id: unknown =
    typeof session === "object" && session !== null ? Reflect.get(session, "id") : ""
  return String(id)
}

async function readSession(
  request: APIRequestContext,
  id: string,
): Promise<{ model: unknown; effort: unknown; status: unknown }> {
  const response = await request.get(`${providerUrl()}/api/sessions/${id}`, { headers: headers() })
  const body: unknown = await response.json()
  const session = typeof body === "object" && body !== null ? Reflect.get(body, "session") : null
  const read = (key: string): unknown =>
    typeof session === "object" && session !== null ? Reflect.get(session, key) : undefined
  return { model: read("model"), effort: read("effort"), status: read("status") }
}

async function openSession(page: Page, id: string): Promise<void> {
  await page.goto(`${providerUrl()}/sessions/${id}#token=${token()}`)
  await expect(page.getByTestId("target-control")).toBeVisible()
}

async function pick(page: Page, select: string, option: string): Promise<void> {
  await page.getByTestId(select).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

test("a model change during a wait of one hour: the same turn continues on the new model", async ({
  page,
  request,
}) => {
  const id = await createSession(request, LIMITED)
  const other = await createSession(request, LIMITED)
  await openSession(page, id)
  await expect(page.getByTestId("target-model")).toContainText(`${LIMITED} display`)

  await send(page, "go")
  // Each request of this model fails with a Retry-After of one hour: the turn waits.
  await expect(page.getByTestId("status-line")).toContainText("Retrying")
  expect((await readSession(request, id)).status).toBe("running")

  // The control is active during the turn. Pick the model that answers.
  await pick(page, "target-model", `${PLAIN} display`)
  await expect(page.getByTestId("reply-text")).toContainText("stub answer from e2e")
  await turnDone(page)
  await expect(page.getByTestId("target-model")).toContainText(`${PLAIN} display`)
  await expect(page.getByTestId("target-error")).toHaveCount(0)

  expect((await readSession(request, id)).model).toBe(PLAIN)
  // The other session of the same server keeps its model.
  expect((await readSession(request, other)).model).toBe(LIMITED)
  // The token is not in the address bar after the page loaded.
  expect(page.url()).not.toContain(token())
})

test("an effort change, and back to the model default", async ({ page, request }) => {
  const id = await createSession(request, PLAIN)
  await openSession(page, id)
  await expect(page.getByTestId("target-effort")).toContainText("Effort: model default")

  await pick(page, "target-effort", "Effort: high")
  await expect(page.getByTestId("target-effort")).toContainText("Effort: high")
  expect((await readSession(request, id)).effort).toBe("high")

  // The new effort is still there after a reload: it comes from the server.
  await page.reload()
  await expect(page.getByTestId("target-effort")).toContainText("Effort: high")

  await pick(page, "target-effort", "Effort: model default")
  await expect(page.getByTestId("target-effort")).toContainText("Effort: model default")
  expect((await readSession(request, id)).effort).toBeUndefined()
})

test("a model with no effort levels has no effort select", async ({ page, request }) => {
  const id = await createSession(request, "e2e-noeffort")
  await openSession(page, id)
  await expect(page.getByTestId("target-model")).toContainText("e2e-noeffort display")
  await expect(page.getByTestId("target-effort")).toHaveCount(0)
})

test("the scripted server shows no target control", async ({ page }) => {
  await page.goto(`/#token=${token()}`)
  await page.getByTestId("new-session").click()
  await expect(page).toHaveURL(/\/sessions\/session-\d+$/u)
  await expect(page.getByTestId("session-title")).toBeVisible()
  await expect(page.getByTestId("target-control")).toHaveCount(0)
})
