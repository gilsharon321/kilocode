/**
 * Shared Cloud execution-location payload types for Agent Manager.
 *
 * Defined here (webview-owned) so both the webview and the extension host
 * import one contract; the host re-exports through src/agent-manager/types.ts.
 *
 * Hosted identity is provider/workspace/session based. A native Kilo session
 * ID is only meaningful inside its workspace scope; compound keys must be
 * used on every extension↔webview surface for Cloud rows.
 */

/** Where a Cloud workspace's billing and authorization scope lives. */
export type CloudScope = { kind: "personal" } | { kind: "org"; organizationID: string }

/** Compound hosted session identity; the webview never routes by sessionID alone for Cloud. */
export interface CloudRef {
  /** Registered project the discovery matched this workspace into. */
  projectId: string
  providerID: string
  workspaceID: string
  organizationID?: string
  sessionID: string
}

/** Passive compute/billing status from the typed workspace-status read. */
export interface CloudWorkspaceStatusView {
  compute: string
  billingBlocked: boolean | null
  activeSessions: number
  hasActiveTurn: boolean
  deleting: boolean
  rateMicrodollarsPerHour?: number
}

/** A root session of one Cloud workspace, in the project sidebar. */
export interface CloudSessionView extends CloudRef {
  key: string
  title?: string
  createdAt: string
  updatedAt: string
  /** Same native session ID appeared in another workspace; both rows are disabled. */
  conflict?: boolean
}

/** One Cloud workspace (execution location) under a registered project. */
export interface CloudWorkspaceView {
  providerID: string
  workspaceID: string
  organizationID?: string
  key: string
  name?: string
  branch?: string
  url?: string
  status?: CloudWorkspaceStatusView
  sessions: CloudSessionView[]
}

/** Cloud aggregate for one registered project. */
export interface CloudScopeView {
  projectId: string
  status: "loading" | "ready" | "signed_out" | "error"
  /** Populated when ready holds zero matching workspaces. */
  empty: boolean
  message?: string
  /** Some scope passes failed; matching rows may be incomplete. */
  degraded?: boolean
  conflictCount?: number
  workspaces: CloudWorkspaceView[]
}

/** Sidebar target kinds gain an explicit Cloud execution location. */
export interface CloudSidebarTarget {
  projectId: string
  kind: "cloud"
  providerID: string
  workspaceID: string
  organizationID?: string
  sessionId: string
}

/** Collision-safe compound key shared by host and webview (no delimiter leaks). */
export const cloudSessionKey = (providerID: string, workspaceID: string, sessionID: string): string =>
  JSON.stringify([providerID, workspaceID, sessionID])

export const cloudWorkspaceKey = (providerID: string, workspaceID: string): string =>
  JSON.stringify([providerID, workspaceID])
