/**
 * The server's import boundary (AGENTS.md, "Core boundary rule").
 *
 * - Core is reached only through subpaths in its package `exports` map.
 * - Relative imports stay inside `server/src`: no reaching into the app, a
 *   sibling repository, or core's source tree.
 * - Server code (not tests) imports nothing at runtime beyond core, Bun, and
 *   Node built-ins. In particular the AI SDK (`ai`) is a dev dependency for
 *   type checks and tests only (spec D24): source files may `import type`
 *   from it, never import it at runtime.
 * - Core is declared once, by the repo root, so the umbrella's `link:dev`
 *   can replace it with a local checkout (S60). A copy declared by `server/`
 *   would shadow the link.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"

import { describe, expect, test } from "bun:test"

import coreManifest from "@minimal-agent/core/package.json"

import serverManifest from "../../package.json"

const SRC = resolve(import.meta.dir, "..")
const REPO = resolve(SRC, "..", "..")
const CORE = "@minimal-agent/core"
const RUNTIME_ALLOWED = /^(?:node:|bun$|bun:)/u
const TEST_ONLY_PACKAGES = new Set(["bun:test", "ai"])

/**
 * A git URL pinned to a full commit SHA or a release tag, never a branch.
 * It must be `git+ssh`: Bun turns `git+https://github.com/...` into a GitHub
 * API tarball download that ignores git credentials (spec 3.2).
 */
const PINNED_CORE_URL =
  /^git\+ssh:\/\/git@github\.com\/gastonmorixe\/minimal-agent-core\.git#(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)$/u

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

/** Every module specifier in a file, type-only imports included. */
function allSpecifiers(code: string): string[] {
  const found = new Set<string>()
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) if (match[1]) found.add(match[1])
  }
  return [...found]
}

/** Module specifiers that load at runtime (type-only imports are erased). */
function runtimeSpecifiers(code: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "tsx" })
  return transpiler.scanImports(code).map((entry) => entry.path)
}

const FILES = sourceFiles(SRC).filter((path) => !path.includes(`${sep}node_modules${sep}`))
const CORE_EXPORTS = new Set(Object.keys(coreManifest.exports))

describe("server import boundary", () => {
  test("finds the server sources", () => {
    expect(FILES.length).toBeGreaterThan(3)
  })

  test("reaches core only through its exports map", () => {
    const offenders: string[] = []
    for (const file of FILES) {
      for (const spec of allSpecifiers(readFileSync(file, "utf8"))) {
        if (spec !== CORE && !spec.startsWith(`${CORE}/`)) continue
        const subpath = `.${spec.slice(CORE.length)}`
        if (!CORE_EXPORTS.has(subpath)) offenders.push(`${relative(SRC, file)}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("keeps relative imports inside server/src", () => {
    const offenders: string[] = []
    for (const file of FILES) {
      for (const spec of allSpecifiers(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue
        const target = resolve(dirname(file), spec)
        const inside = target.startsWith(SRC + sep)
        const isManifest = target === resolve(SRC, "..", "package.json")
        if (!inside && !isManifest) offenders.push(`${relative(SRC, file)}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("loads only core, Bun, and Node built-ins at runtime outside tests", () => {
    const offenders: string[] = []
    for (const file of FILES) {
      const isTest = file.endsWith(".test.ts")
      for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".") || spec === CORE || spec.startsWith(`${CORE}/`)) continue
        if (RUNTIME_ALLOWED.test(spec)) continue
        if (isTest && TEST_ONLY_PACKAGES.has(spec)) continue
        offenders.push(`${relative(SRC, file)}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

interface Manifest {
  dependencies?: Record<string, string>
}

function readManifest(path: string): Manifest {
  const value: unknown = JSON.parse(readFileSync(join(REPO, path), "utf8"))
  return typeof value === "object" && value !== null ? value : {}
}

describe("core dependency", () => {
  test("is the root's only runtime dependency and is pinned", () => {
    const root = readManifest("package.json")
    expect(Object.keys(root.dependencies ?? {})).toEqual([CORE])
    expect(root.dependencies?.[CORE]).toMatch(PINNED_CORE_URL)
  })

  test("is not declared again by the server or the app", () => {
    expect("dependencies" in serverManifest).toBe(false)
    expect(readManifest("app/package.json").dependencies?.[CORE]).toBeUndefined()
  })

  test("installs the package named @minimal-agent/core", () => {
    expect(coreManifest.name).toBe(CORE)
  })
})
