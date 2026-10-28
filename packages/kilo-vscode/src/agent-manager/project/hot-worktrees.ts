/**
 * Worktree IDs the stats poller should refresh at the fast cadence: the
 * active target, running scripts, and worktrees with busy sessions.
 * Extracted from AgentManagerProvider (file-size cap); vscode-free.
 */

import type { SidebarTarget } from "./route"

interface HotState {
  getActiveTarget(): SidebarTarget | undefined
  getSession(id: string): { worktreeId?: string | null } | undefined
}

export function hotWorktrees(input: {
  state: HotState | undefined
  runs: ReadonlyArray<{ state: string; worktreeId: string }>
  busy: Iterable<string>
  /** State of the project that owns a live session, when it is not the active one. */
  owner: (sessionID: string) => HotState | undefined
}): Set<string> {
  const ids = new Set<string>()
  const target = input.state?.getActiveTarget()
  if (target?.kind === "worktree") ids.add(target.worktreeId)
  if (target?.kind === "session") {
    const id = input.state?.getSession(target.sessionId)?.worktreeId
    if (id) ids.add(id)
  }
  for (const status of input.runs) {
    if (status.state === "running" || status.state === "stopping") ids.add(status.worktreeId)
  }
  for (const sid of input.busy) {
    const id = input.owner(sid)?.getSession(sid)?.worktreeId ?? input.state?.getSession(sid)?.worktreeId
    if (id) ids.add(id)
  }
  return ids
}
