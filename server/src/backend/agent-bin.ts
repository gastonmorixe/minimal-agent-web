/**
 * Publish `MINIMAL_AGENT_BIN`: the command that starts another agent process.
 *
 * The sub-agents plugin starts a worker with `selfSpawn().agent()`. From
 * source, that is `[execPath, process.argv[1]]`, and in this server
 * `process.argv[1]` is `server/src/main.ts`: a worker would boot a second web
 * server in place of a CLI worker. So a web host publishes the CLI entry of
 * the sibling checkout. The plugin reads the var for every spawn, so an
 * explicit value from the environment (or config) always wins.
 *
 * @module backend/agent-bin
 */

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

/** The dir name of the dev-time CLI checkout next to this repo. */
const CLI_CHECKOUT_DIR = "minimal-agent-cli"

/** Inputs of {@link publishAgentBin}. */
export interface PublishAgentBinOptions {
  /** The web install dir (server/src/../..). */
  installDir: string
  /** The process env to write. Default `process.env`. */
  env?: NodeJS.ProcessEnv
  /** The runtime that runs the CLI entry. Default `process.execPath`. */
  execPath?: string
  /** Existence probe, for tests. Default `existsSync`. */
  exists?: (path: string) => boolean
}

/**
 * Write `MINIMAL_AGENT_BIN` when it is unset and the CLI entry exists.
 * Returns the value written, or `undefined` when nothing changed.
 */
export function publishAgentBin(opts: PublishAgentBinOptions): string | undefined {
  const env = opts.env ?? process.env
  if (env.MINIMAL_AGENT_BIN?.trim()) return undefined
  const entry = join(dirname(opts.installDir), CLI_CHECKOUT_DIR, "src", "index.ts")
  if (!(opts.exists ?? existsSync)(entry)) return undefined
  const value = `${opts.execPath ?? process.execPath} ${entry}`
  env.MINIMAL_AGENT_BIN = value
  return value
}
