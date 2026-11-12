/**
 * Copy the plugins listed in `plugins.bundle.json` into `<web>/plugins`,
 * the embedded plugin tier (see `pluginRoots()` in `server/src/main.ts`).
 * An empty list does nothing and creates nothing.
 *
 * @module scripts/bundle-plugins
 */

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/** Inputs of {@link bundlePlugins}. */
export interface BundlePluginsOptions {
  /** Path of the JSON list file: `{"plugins": ["ma-foo-plugin"]}`. */
  listFile: string
  /** The plugins repo checkout: each id is a dir name under it. */
  pluginsRepo: string
  /** The embedded root to fill: each plugin lands in `<destDir>/<id>`. */
  destDir: string
}

/** Read and validate the plugin id list. Throws on a bad file or id. */
export function readBundleList(listFile: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(listFile, "utf8"))
  const plugins: unknown =
    typeof parsed === "object" && parsed !== null && "plugins" in parsed
      ? parsed.plugins
      : undefined
  if (!Array.isArray(plugins)) throw new Error(`${listFile}: "plugins" must be an array`)
  const ids: string[] = []
  for (const id of plugins) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes("..")) {
      throw new Error(`${listFile}: invalid plugin id ${JSON.stringify(id)}`)
    }
    ids.push(id)
  }
  return ids
}

/**
 * Copy each listed plugin dir from `pluginsRepo` to `destDir/<id>`.
 * Returns the copied ids. An empty list returns `[]` and touches nothing.
 */
export function bundlePlugins(options: BundlePluginsOptions): string[] {
  const ids = readBundleList(options.listFile)
  if (ids.length === 0) return []
  for (const id of ids) {
    const src = join(options.pluginsRepo, id)
    if (!existsSync(join(src, "manifest.json")) && !existsSync(join(src, "provider.json"))) {
      throw new Error(`plugin ${id}: ${src} has no manifest.json or provider.json`)
    }
  }
  mkdirSync(options.destDir, { recursive: true })
  for (const id of ids) {
    cpSync(join(options.pluginsRepo, id), join(options.destDir, id), { recursive: true })
  }
  return ids
}

if (import.meta.main) {
  const webRoot = resolve(dirname(import.meta.path), "..")
  const copied = bundlePlugins({
    listFile: join(webRoot, "plugins.bundle.json"),
    pluginsRepo: process.env.MA_BUNDLE_PLUGINS_REPO ?? join(webRoot, "..", "minimal-agent-plugins"),
    destDir: join(webRoot, "plugins"),
  })
  if (copied.length > 0) console.log(`bundled plugins: ${copied.join(", ")}`)
}
