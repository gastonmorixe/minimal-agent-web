/**
 * The provider-mode server of the Playwright e2e suite.
 *
 * The e2e suite runs the real server in scripted mode, which has no
 * provider, no model and no credential: a scripted session has no target to
 * change. So the tests of the target control need a second server, in
 * provider mode. This script starts it with no network and no real
 * credential:
 *
 * - It writes a stub provider plugin into a temp agent home
 *   (`server/src/backend/stub-provider.fixture.ts`, with `targetModels`): a
 *   plain model, a model with effort levels, and a model whose requests fail
 *   with a `Retry-After` of one hour.
 * - It starts `server/src/main.ts` with an env that keeps the boot inside
 *   that home: no plugin clone, no sibling checkout, no real user home.
 *
 * `playwright.config.ts` runs it as a second `webServer`. It passes `PORT`
 * and `MA_WEB_TOKEN` through. On SIGTERM or SIGINT it stops the server and
 * removes the temp home.
 *
 * @module scripts/e2e-provider-server
 */

import { rmSync } from "node:fs"
import { join } from "node:path"

import {
  writeStubProviderHome,
  writeTextStubPlugin,
} from "../server/src/backend/stub-provider.fixture.ts"

/** The provider id of the stub. The model ids start with it (`e2e-plain`, ...). */
const PROVIDER_ID = "e2e"

const stub = writeStubProviderHome(PROVIDER_ID, { targetModels: true })
// The web boot checks the text contracts: give it the stub text plugin.
writeTextStubPlugin(stub.home)

const env: Record<string, string | undefined> = { ...process.env }
for (const key of ["MINIMAL_AGENT_CONFIG", "MINIMAL_AGENT_TEST_AUTH"]) delete env[key]

const child = Bun.spawn(["bun", join(import.meta.dir, "..", "server", "src", "main.ts")], {
  env: {
    ...env,
    MINIMAL_AGENT_HOME: stub.home,
    HOME: join(stub.root, "user-home"),
    MINIMAL_AGENT_NO_PLUGIN_SYNC: "1",
    MINIMAL_AGENT_PLUGIN_SIBLINGS: join(stub.root, "no-such-siblings"),
    MA_WEB_SCRIPTED: "",
  },
  stdout: "inherit",
  stderr: "inherit",
})

function stop(): void {
  child.kill()
  rmSync(stub.root, { recursive: true, force: true })
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)

const code = await child.exited
rmSync(stub.root, { recursive: true, force: true })
process.exit(code)
