/**
 * Canonical origin URL for a project root, read from its `.git/config`.
 * Mirrors the `.git` resolution in project/avatar.ts but returns the full
 * origin URL (any host), used to match Cloud workspaces to projects.
 */

import * as fs from "fs"
import * as path from "path"

const cache = new Map<string, string | undefined>()

function config(root: string): string | undefined {
  const dot = path.join(root, ".git")
  const stat = fs.statSync(dot, { throwIfNoEntry: false })
  if (!stat) return undefined
  if (stat.isDirectory()) return path.join(dot, "config")
  const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf8"))
  if (!match) return undefined
  const dir = path.resolve(root, match[1].trim())
  const common = path.join(dir, "commondir")
  if (!fs.existsSync(common)) return path.join(dir, "config")
  return path.join(path.resolve(dir, fs.readFileSync(common, "utf8").trim()), "config")
}

/** The project's origin remote URL, cached per root; undefined without one. */
export function originUrl(root: string): string | undefined {
  if (cache.has(root)) return cache.get(root)
  let url: string | undefined
  try {
    const file = config(root)
    const text = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    const section = /\[remote "origin"\]([^[]*)/.exec(text)?.[1] ?? ""
    url = /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() || undefined
  } catch {
    url = undefined
  }
  cache.set(root, url)
  return url
}
