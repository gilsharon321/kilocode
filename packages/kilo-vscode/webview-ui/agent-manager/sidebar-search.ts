import type { SectionState } from "../src/types/messages"
import type { Activity } from "../src/utils/session-activity"
import type { CloudSidebarTarget } from "./cloud-types"

export type SidebarSearchState = Activity

type SearchItem = {
  key: string
  projectId?: string
  title: string
  meta: string[]
  search: string
  updatedAt: string
  state: SidebarSearchState
  busy?: boolean
  visible: boolean
  section?: SectionState
}

export type SidebarSearchItem =
  | (SearchItem & {
      kind: "local"
      group: "contexts"
      count: number
    })
  | (SearchItem & {
      kind: "worktree"
      group: "contexts"
      worktreeId: string
      count: number
    })
  | (SearchItem & {
      kind: "session"
      group: "sessions"
      sessionId: string
      location: "local" | "worktree"
      worktreeId?: string
    })
  | (SearchItem & {
      kind: "cloud"
      group: "sessions"
      target: CloudSidebarTarget
    })
