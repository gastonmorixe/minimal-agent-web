/**
 * Playwright e2e suite (S58): the built app and the server with the fake
 * backend, on Chromium. `bun run test:e2e` runs it; `bun run check` runs it
 * after the build.
 *
 * The suite uses the `@playwright/test` version whose Chromium build is
 * installed (`PLAYWRIGHT_BROWSERS_PATH`). CI installs that build first.
 */

import { randomBytes } from "node:crypto"

import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.E2E_PORT ?? 4390)

// One token per run. Workers inherit it from this process's environment.
process.env.MA_WEB_TOKEN ??= randomBytes(32).toString("base64url")

export default defineConfig({
  testDir: "e2e",
  outputDir: "tmp/e2e-results",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run server/src/main.ts",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    env: {
      PORT: String(port),
      MA_WEB_TOKEN: process.env.MA_WEB_TOKEN,
      MA_WEB_FAKE_STEP_MS: "20",
    },
  },
})
