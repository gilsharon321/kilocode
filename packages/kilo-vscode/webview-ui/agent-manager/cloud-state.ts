/**
 * Cloud execution-location state for the Agent Manager webview.
 *
 * Subscribes to `agentManager.cloudState` pushes and exposes the per-project
 * Cloud scopes plus which hosted session/row is currently focused. Compound
 * `key`s (provider/workspace/session JSON) never cross local rows.
 */

import { createMemo, createSignal } from "solid-js"
import type { CloudScopeView, CloudSidebarTarget } from "./cloud-types"

export interface CloudFocus {
  projectId: string
  key: string
  target: CloudSidebarTarget
}

export function createCloudState(subscribe: (handler: (message: unknown) => void) => () => void) {
  const [scopes, setScopes] = createSignal<CloudScopeView[]>([])
  const [focus, setFocus] = createSignal<CloudFocus>()
  subscribe((message) => {
    const cloud = message as { type?: string; scopes?: CloudScopeView[] } | undefined
    if (cloud?.type === "agentManager.cloudState" && Array.isArray(cloud.scopes)) setScopes(cloud.scopes)
  })
  const scopeFor = createMemo(() => {
    const map = new Map<string, CloudScopeView>()
    for (const scope of scopes()) map.set(scope.projectId, scope)
    return map
  })
  return {
    scopes,
    scopeFor,
    focus,
    focusCloud: (next: CloudFocus) => setFocus(next),
    clearFocus: (projectId?: string) =>
      setFocus((current) => (current && (!projectId || current.projectId === projectId) ? undefined : current)),
  }
}
