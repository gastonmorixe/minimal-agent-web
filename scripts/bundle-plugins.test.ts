import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, test } from "bun:test"

import { buildPluginCatalog } from "@minimal-agent/core/host/plugin-catalog"

import { bundlePlugins } from "./bundle-plugins.ts"

function setup(plugins: unknown): { dir: string; listFile: string; repo: string; dest: string } {
  const dir = mkdtempSync(join(tmpdir(), "ma-web-bundle-"))
  const repo = join(dir, "repo")
  const pkg = join(repo, "ma-x-plugin")
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, "manifest.json"), JSON.stringify({ id: "x", name: "X" }))
  const listFile = join(dir, "list.json")
  writeFileSync(listFile, JSON.stringify({ plugins }))
  return { dir, listFile, repo, dest: join(dir, "plugins") }
}

describe("bundlePlugins", () => {
  test("empty list creates nothing", () => {
    const t = setup([])
    try {
      expect(bundlePlugins({ listFile: t.listFile, pluginsRepo: t.repo, destDir: t.dest })).toEqual(
        [],
      )
      expect(existsSync(t.dest)).toBe(false)
    } finally {
      rmSync(t.dir, { recursive: true, force: true })
    }
  })

  test("copies listed plugins and the loader finds them as embedded", () => {
    const t = setup(["ma-x-plugin"])
    try {
      bundlePlugins({ listFile: t.listFile, pluginsRepo: t.repo, destDir: t.dest })
      expect(readFileSync(join(t.dest, "ma-x-plugin", "manifest.json"), "utf8")).toContain('"x"')
      const entries = buildPluginCatalog(
        { embedded: [t.dest] },
        { config: { forceDisabled: new Set(), forceEnabled: new Set() }, env: {} },
      )
      const found = entries.find((e) => e.id === "x")
      expect(found?.root).toBe("embedded")
    } finally {
      rmSync(t.dir, { recursive: true, force: true })
    }
  })

  test("rejects ids that are not plain dir names", () => {
    for (const bad of ["../evil", "a/b", "..", "", 3]) {
      const t = setup([bad])
      try {
        expect(() =>
          bundlePlugins({ listFile: t.listFile, pluginsRepo: t.repo, destDir: t.dest }),
        ).toThrow(/invalid plugin id/)
        expect(existsSync(t.dest)).toBe(false)
      } finally {
        rmSync(t.dir, { recursive: true, force: true })
      }
    }
  })

  test("rejects a source without manifest.json or provider.json", () => {
    const t = setup(["ma-y-plugin"])
    try {
      mkdirSync(join(t.repo, "ma-y-plugin"))
      expect(() =>
        bundlePlugins({ listFile: t.listFile, pluginsRepo: t.repo, destDir: t.dest }),
      ).toThrow(/no manifest\.json or provider\.json/)
      expect(existsSync(t.dest)).toBe(false)
    } finally {
      rmSync(t.dir, { recursive: true, force: true })
    }
  })
})

describe("plugins.bundle.json", () => {
  test("parses and is an empty list today", () => {
    const file = join(dirname(import.meta.path), "..", "plugins.bundle.json")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ plugins: [] })
  })
})
