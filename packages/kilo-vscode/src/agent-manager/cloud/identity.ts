/**
 * Compound hosted identity for Agent Manager Cloud sessions.
 *
 * Identity is provider/workspace/session based. Native session IDs are only
 * unique under the approved D1 decision: the catalog is the identity source,
 * a session ID seen in two workspaces of one provider is marked conflicted and
 * disabled, so raw session IDs may key chat state only for non-conflicted
 * rows. Compound keys stay collision-safe even for adversarial IDs (Cloud IDs
 * are not guaranteed to respect any delimiter).
 */

import type { CloudRef } from "../../../webview-ui/agent-manager/cloud-types"

/** Collision-safe compound key; parts are JSON-encoded so no delimiter leaks. */
function compound(parts: string[]): string {
  return JSON.stringify(parts)
}

export function workspaceKey(providerID: string, workspaceID: string): string {
  return compound([providerID, workspaceID])
}

export function sessionKey(providerID: string, workspaceID: string, sessionID: string): string {
  return compound([providerID, workspaceID, sessionID])
}

/** Stable compound key from a client-provided ref. */
export function refKey(ref: CloudRef): string {
  return sessionKey(ref.providerID, ref.workspaceID, ref.sessionID)
}

/**
 * Canonical repository URL identity for matching Cloud workspaces to projects.
 * SCP-like `git@host:path`, ssh, and https normalize to `host/lowercased path`
 * without credentials, port, or a `.git` suffix. Paths compare
 * case-insensitively; repository hosts are case-insensitive in practice.
 */
export function canonicalRepositoryUrl(input: string | undefined | null): string | undefined {
  const raw = input?.trim()
  if (!raw) return undefined
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  let rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^git@/i, "")
  // Strip credentials/userinfo from the host part.
  const at = rest.lastIndexOf("@")
  if (at !== -1 && !rest.slice(0, at).includes("/")) rest = rest.slice(at + 1)
  // First colon before any slash is either a port or an scp-style separator.
  const colon = rest.indexOf(":")
  const slash = rest.indexOf("/")
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    const after = rest.slice(colon + 1)
    // A numeric segment is a port only after a scheme; scp-like `host:123/repo` is a path.
    if (scheme && /^\d+(\/|$)/.test(after)) {
      rest = rest.slice(0, colon) + (slash === -1 ? "" : rest.slice(slash))
    } else {
      rest = `${rest.slice(0, colon)}/${after}`
    }
  }
  const [host = "", ...pathParts] = rest.split("/")
  const path = pathParts
    .join("/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
  return host && path ? `${host.toLowerCase()}/${path.toLowerCase()}` : undefined
}

/** Whether a repository URL should match a registered project's origin. */
export function repositoriesMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = canonicalRepositoryUrl(a)
  const right = canonicalRepositoryUrl(b)
  return left !== undefined && left === right
}
