/**
 * Playwright e2e suite (S58, updated for S53): the built app and the real
 * server (`RuntimeBackend` in scripted mode, `MA_WEB_SCRIPTED=1`) on Chromium.
 * Scripted mode needs no provider plugin and no network.
 * `bun run test:e2e` runs it; `bun run check` runs it after the build.
 *
 * A second server runs in provider mode, on a stub provider plugin with no
 * network (`scripts/e2e-provider-server.ts`), on the next port. A scripted
 * session has no target (credential, model, effort) to change, so the tests
 * of the target control (`e2e/target.spec.ts`) use this one.
 *
 * The suite uses the `@playwright/test` version whose Chromium build is
 * installed. `bun run test:e2e`'s own script installs that build when
 * `$CI` is set (see package.json and AGENTS.md's "Tests" section); a
 * sandbox with a preinstalled build at a fixed `PLAYWRIGHT_BROWSERS_PATH`
 * and no `$CI` skips the install and uses that build directly.
 */

import { randomBytes } from "node:crypto"

import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.E2E_PORT ?? 4390)
// The provider-mode server. `e2e/helpers.ts` computes the same port.
const providerPort = port + 1

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
  webServer: [
    {
      command: "bun run server/src/main.ts",
      url: `http://127.0.0.1:${port}/`,
      reuseExistingServer: false,
      env: {
        PORT: String(port),
        MA_WEB_SCRIPTED: "1",
        MA_WEB_TOKEN: process.env.MA_WEB_TOKEN,
        MA_WEB_SCRIPT_STEP_MS: "20",
        MA_WEB_RETRY_CEILING_MS: "20",
      },
    },
    {
      command: "bun run scripts/e2e-provider-server.ts",
      url: `http://127.0.0.1:${providerPort}/`,
      reuseExistingServer: false,
      env: {
        PORT: String(providerPort),
        MA_WEB_TOKEN: process.env.MA_WEB_TOKEN,
      },
    },
  ],
})
