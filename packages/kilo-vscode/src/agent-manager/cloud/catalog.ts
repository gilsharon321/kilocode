/**
 * CloudCatalog — automatic hosted discovery for Agent Manager projects.
 *
 * Enumerates authorized Kilo Cloud workspaces and their paginated root
 * sessions through the shared local backend connection (the session host SDK
 * surface), matches their canonical repository identity to registered
 * projects, and publishes loading/ready/signed-out/error states.
 *
 * Discovered state is authoritative for identity (approved D1): the catalog is
 * the only source that binds provider + workspace + session. If one provider
 * reports the same native session ID in two workspaces, both rows are marked
 * conflicted and disabled instead of being guessed at.
 *
 * Every read here is passive (catalog/status): nothing allocates compute or
 * opens billing. Workspace listing targets the default provider — fine for the
 * built-in sole Cloud provider, and the boundary is recorded rather than
 * hidden.
 */

import type {
  KiloClient,
  SessionHostWorkspace,
  SessionHostWorkspaceSession,
  SessionHostWorkspaceStatus,
} from "@kilocode/sdk/v2/client"
import type {
  CloudScope,
  CloudScopeView,
  CloudSessionView,
  CloudWorkspaceStatusView,
  CloudWorkspaceView,
} from "../../../webview-ui/agent-manager/cloud-types"
import { repositoriesMatch, sessionKey, workspaceKey } from "./identity"

const MAX_WORKSPACE_PAGES = 50
const MAX_SESSION_PAGES = 20
const WORKSPACE_PAGE = "50"
const SESSION_PAGE = "100"

/** One registered project's repository identity, resolved by the provider. */
export interface CatalogProject {
  id: string
  /** Canonical origin URL, or undefined when it cannot be read (no Cloud rows then). */
  repositoryUrl?: string
}

export interface CatalogSource {
  /** Current backend client; rejects while disconnected. */
  client(): Promise<KiloClient>
  /** Registered projects, including the pinned one. */
  projects(): Promise<CatalogProject[]>
  log(msg: string): void
  /** Project set resolved; publish the loading scopes without waiting for discovery. */
  changed?(): void
}

interface WorkspaceEntry {
  providerID: string
  workspaceID: string
  organizationID?: string
  projectId: string
  key: string
  name?: string
  branch?: string
  url?: string
  sessions: CloudSessionView[]
}

export class CloudCatalog {
  private generation = 0
  private discovery: Promise<void> | undefined
  private entries = new Map<string, WorkspaceEntry>()
  private statuses = new Map<string, SessionHostWorkspaceStatus>()
  private state: CloudScopeView["status"] = "loading"
  private message: string | undefined
  private degraded = false
  private conflictCount = 0
  private knownProjects: string[] = []

  constructor(private readonly source: CatalogSource) {}

  /** Kick a reconcile; concurrent calls share one pass. Safe while disconnected. */
  refresh(): Promise<void> {
    if (this.discovery) return this.discovery
    const generation = ++this.generation
    // Keep the last good catalog and any error visible; flipping through
    // loading/error on every poll makes the Cloud list blink.
    if (this.entries.size === 0 && this.state !== "ready") this.state = "loading"
    this.discovery = this.run(generation)
      .catch((err) => {
        if (generation !== this.generation) return
        console.error("[Kilo New] Cloud catalog refresh failed:", err)
        if (this.entries.size > 0) {
          this.state = "ready"
          this.degraded = true
          this.message = describe(err)
          return
        }
        this.state = "error"
        this.message = describe(err)
      })
      .finally(() => {
        if (generation === this.generation) this.discovery = undefined
      })
    return this.discovery
  }

  get busy(): boolean {
    return this.discovery !== undefined
  }

  /** Serializable snapshot for the webview, one scope per registered project. */
  snapshot(): CloudCatalogSnapshot {
    const byProject = new Map<string, CloudWorkspaceView[]>()
    for (const entry of this.entries.values()) {
      const list = byProject.get(entry.projectId) ?? []
      list.push(this.view(entry))
      byProject.set(entry.projectId, list)
    }
    const scopes: CloudScopeView[] = this.knownProjects.map((projectId) => {
      const workspaces = (byProject.get(projectId) ?? []).sort((a, b) => a.key.localeCompare(b.key))
      return {
        projectId,
        status: this.state,
        message: this.message,
        empty: this.state === "ready" && workspaces.length === 0 && this.conflictCount === 0 && !this.degraded,
        degraded: this.degraded || undefined,
        conflictCount: this.conflictCount || undefined,
        workspaces,
      }
    })
    return { status: this.state, scopes }
  }

  private async run(generation: number): Promise<void> {
    const stale = () => generation !== this.generation
    // Resolve projects before the backend client so the sidebar can render a
    // loading/error Cloud location per project even while disconnected.
    const projects = await this.source.projects()
    if (stale()) return
    this.knownProjects = projects.map((project) => project.id)
    if (projects.length === 0) {
      this.reset("ready")
      this.source.changed?.()
      return
    }
    this.source.changed?.()
    const client = await this.source.client()
    const results = await this.passes(client, stale)
    if (!results || stale()) return
    // A total failure must not erase a working catalog; keep the rows and
    // degrade until a pass succeeds again.
    const failed = results.filter((pass) => !!pass.result.error).length
    if (failed > 0 && failed === results.length && this.entries.size > 0) {
      this.state = "ready"
      this.degraded = true
      this.message = results.map((pass) => pass.result.error?.message).find((message) => !!message)
      return
    }
    const entries = this.collect(projects, results)
    // A partial failure that returns nothing must not empty a working catalog.
    if (entries.size === 0 && this.entries.size > 0 && failed > 0) {
      this.state = "ready"
      this.degraded = true
      this.message = results.map((pass) => pass.result.error?.message).find((message) => !!message)
      return
    }
    for (const entry of entries.values()) {
      if (stale()) return
      entry.sessions = await this.sessions(client, entry, stale)
    }
    const conflictCount = markConflicts(entries)
    const statuses = new Map<string, SessionHostWorkspaceStatus>()
    for (const entry of entries.values()) {
      if (stale()) return
      const status = await this.statusOf(client, entry)
      if (status) statuses.set(workspaceKey(status.id.providerID, status.id.workspaceID), status)
    }
    if (stale()) return
    this.entries = entries
    this.statuses = statuses
    this.conflictCount = conflictCount
    this.settle(results)
  }

  /** One discovery pass per explicit scope: personal, then each authorized organization. */
  private async passes(client: KiloClient, stale: () => boolean) {
    const orgIDs = await this.scopes(client, stale)
    const scopes: Array<string | undefined> = [undefined, ...orgIDs]
    const results = []
    for (const organizationID of scopes) {
      if (stale()) return
      results.push({ organizationID, result: await this.pass(client, organizationID) })
    }
    return results
  }

  /** Union workspaces across scopes: first scope wins, deleted ones cannot route. */
  private collect(projects: CatalogProject[], results: Awaited<ReturnType<CloudCatalog["passes"]>>) {
    const entries = new Map<string, WorkspaceEntry>()
    for (const { organizationID, result } of results ?? []) {
      for (const workspace of result.workspaces) {
        const projectId = workspace.deletionState === "deleted" ? undefined : owner(projects, workspace)
        if (!projectId) continue
        const key = workspaceKey(workspace.id.providerID, workspace.id.workspaceID)
        if (entries.has(key)) continue
        entries.set(key, {
          providerID: workspace.id.providerID,
          workspaceID: workspace.id.workspaceID,
          organizationID,
          projectId,
          key,
          name: workspace.name ?? undefined,
          branch: workspace.repository?.branch ?? undefined,
          url: workspace.repository?.url ?? undefined,
          sessions: [],
        })
      }
    }
    return entries
  }

  /** Authorization failures stay explicit; partial failure degrades instead of emptying. */
  private settle(results: NonNullable<Awaited<ReturnType<CloudCatalog["passes"]>>>): void {
    const authFailed = results.filter((pass) => pass.result.error?.signedOut).length
    const otherFailed = results.filter((pass) => pass.result.error && !pass.result.error.signedOut).length
    const failed = authFailed + otherFailed
    this.degraded = failed > 0 && failed < results.length
    if (failed > 0 && failed === results.length) {
      this.state = authFailed > 0 ? "signed_out" : "error"
      this.message = results.map((pass) => pass.result.error?.message).find((message) => !!message)
      return
    }
    this.state = "ready"
    this.message = undefined
  }

  private reset(status: CloudScopeView["status"]): void {
    this.state = status
    this.entries = new Map()
    this.statuses = new Map()
    this.knownProjects = []
    this.degraded = false
    this.conflictCount = 0
    this.message = undefined
  }

  /** One paginated scope pass. Authorization failures stay explicit. */
  private async pass(client: KiloClient, organizationID?: string) {
    const workspaces: SessionHostWorkspace[] = []
    try {
      let cursor: string | undefined
      let pages = 0
      const cursors = new Set<string>()
      do {
        const response = await client.sessionHost.listWorkspaces(
          {
            limit: WORKSPACE_PAGE,
            sessionLimit: SESSION_PAGE,
            ...(cursor ? { cursor } : {}),
            ...(organizationID ? { organizationID } : {}),
          },
          { throwOnError: true },
        )
        const data = response.data as { items?: SessionHostWorkspace[]; cursor?: string | null }
        workspaces.push(...(data?.items ?? []))
        const next = data?.cursor ?? undefined
        if (next && cursors.has(next)) break
        cursors.add(cursor ?? "")
        cursor = next
        pages++
      } while (cursor && pages < MAX_WORKSPACE_PAGES)
      return { workspaces, error: undefined }
    } catch (error) {
      this.source.log(`Cloud workspace pass failed: ${error}`)
      return { workspaces, error: { signedOut: signedOut(error), message: describe(error) } }
    }
  }

  /** All root sessions of one workspace, fully paginated. */
  private async sessions(client: KiloClient, entry: WorkspaceEntry, stale: () => boolean): Promise<CloudSessionView[]> {
    const rows: CloudSessionView[] = []
    try {
      let cursor: string | undefined
      let pages = 0
      const cursors = new Set<string>()
      do {
        const response = await client.sessionHost.listWorkspaceSessions(
          {
            providerID: entry.providerID,
            workspaceID: entry.workspaceID,
            limit: SESSION_PAGE,
            ...(cursor ? { cursor } : {}),
            ...(entry.organizationID ? { organizationID: entry.organizationID } : {}),
          },
          { throwOnError: true },
        )
        const data = response.data as { items?: SessionHostWorkspaceSession[]; cursor?: string | null }
        for (const item of data?.items ?? []) {
          rows.push({
            projectId: entry.projectId,
            providerID: entry.providerID,
            workspaceID: entry.workspaceID,
            organizationID: entry.organizationID,
            sessionID: item.id.sessionID,
            key: sessionKey(entry.providerID, entry.workspaceID, item.id.sessionID),
            title: item.title ?? undefined,
            createdAt: new Date(item.created).toISOString(),
            updatedAt: new Date(item.updated).toISOString(),
          })
        }
        const next = data?.cursor ?? undefined
        if (next && cursors.has(next)) break
        cursors.add(cursor ?? "")
        cursor = next
        pages++
      } while (cursor && pages < MAX_SESSION_PAGES)
      if (stale()) return rows
      return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch (error) {
      // A session listing failure keeps the workspace row but drops its children.
      this.source.log(`Cloud session list failed for workspace ${entry.workspaceID}: ${error}`)
      return rows
    }
  }

  /** Passive compute/billing read; failures keep the row without status. */
  private async statusOf(client: KiloClient, entry: WorkspaceEntry): Promise<SessionHostWorkspaceStatus | undefined> {
    try {
      const response = await client.sessionHost.getWorkspaceStatus(
        { providerID: entry.providerID, workspaceID: entry.workspaceID, organizationID: entry.organizationID },
        { throwOnError: true },
      )
      return response.data as SessionHostWorkspaceStatus | undefined
    } catch (error) {
      this.source.log(`Cloud status failed for workspace ${entry.workspaceID}: ${error}`)
      return undefined
    }
  }

  /** Authorized session-host scope UUIDs from the account profile. */
  private async scopes(client: KiloClient, stale: () => boolean): Promise<string[]> {
    try {
      const response = await client.kilo.profile(undefined, { throwOnError: true })
      const data = response.data as { profile?: { organizations?: Array<{ id: string }> } }
      if (stale()) return []
      return (data.profile?.organizations ?? []).map((org) => org.id).filter((id) => id.length > 0)
    } catch (error) {
      this.source.log(`Cloud scope discovery failed: ${error}`)
      return []
    }
  }

  private view(entry: WorkspaceEntry): CloudWorkspaceView {
    const status = this.statuses.get(workspaceKey(entry.providerID, entry.workspaceID))
    const view: CloudWorkspaceStatusView | undefined = status && {
      compute: status.compute?.status ?? "unknown",
      deleting: status.deletionState !== "active",
      activeSessions: status.activity?.activeSessionCount ?? 0,
      hasActiveTurn: status.activity?.hasActiveTurn ?? false,
      billingBlocked: status.wakeOnInput === undefined ? null : status.wakeOnInput.blockedReason === "billing_blocked",
    }
    if (status?.billing?.rate) view!.rateMicrodollarsPerHour = status.billing.rate.estimatedHourlyMicrodollars
    return {
      providerID: entry.providerID,
      workspaceID: entry.workspaceID,
      organizationID: entry.organizationID,
      key: entry.key,
      name: entry.name,
      branch: entry.branch,
      url: entry.url,
      status: view,
      sessions: entry.sessions,
    }
  }
}

export interface CloudCatalogSnapshot {
  status: CloudScopeView["status"]
  scopes: CloudScopeView[]
}

/** Mark (and count) native session IDs that appear in more than one workspace. */
function markConflicts(entries: Map<string, WorkspaceEntry>): number {
  const seen = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const entry of entries.values()) {
    for (const row of entry.sessions) {
      const native = `${row.providerID}\u0000${row.sessionID}`
      const first = seen.get(native)
      if (first !== undefined && first !== entry.key) {
        conflicted.add(native)
        continue
      }
      seen.set(native, entry.key)
    }
  }
  for (const entry of entries.values()) {
    for (const row of entry.sessions) {
      const native = `${row.providerID}\u0000${row.sessionID}`
      row.conflict = conflicted.has(native) ? true : undefined
    }
  }
  return conflicted.size
}

function owner(projects: CatalogProject[], workspace: SessionHostWorkspace): string | undefined {
  const url = workspace.repository?.url
  if (!url) return undefined
  for (const project of projects) {
    if (repositoriesMatch(url, project.repositoryUrl)) return project.id
  }
  return undefined
}

function signedOut(error: unknown): boolean {
  const body = (error as { data?: { body?: { message?: string }; message?: string }; message?: string }) ?? {}
  const text = `${JSON.stringify(body.data ?? body.message ?? "")} ${String(error)}`
  return /401|403|unauthorized|signed out|credentials|authenticat|log ?in/i.test(text)
}

function describe(error: unknown): string {
  const cast = (error as { data?: { body?: { message?: string } }; message?: string }) ?? {}
  return cast.data?.body?.message ?? cast.message ?? String(error)
}
