import { createEffect, createMemo, createSignal, type Component } from "solid-js"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { TooltipKeybind } from "@kilocode/kilo-ui/tooltip"
import type {
  AgentManagerSidebarTarget,
  AgentManagerStateMessage,
  AgentProjectSnapshot,
  LocalGitStats,
  PRStatus,
  ProjectSessionInfo,
  RunStatus,
  WorktreeGitStats,
} from "../src/types/messages"
import type { CloudScopeView, CloudSidebarTarget } from "./cloud-types"
import type { LanguageContextValue } from "../src/context/language"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { useVSCode } from "../src/context/vscode"
import { ProjectsSection } from "./ProjectsSection"
import { ProjectSidebarBody } from "./ProjectSidebarBody"
import { SidebarSearchMenu, type SidebarSearchMenuRef } from "./SidebarSearchMenu"
import type { SidebarSearchItem } from "./sidebar-search"
import { label, type Activity } from "../src/utils/session-activity"
import { LOCAL } from "./navigate"
import { NewWorktreeDialog } from "./NewWorktreeDialog"
import { NewProjectDialog } from "./NewProjectDialog"
import { CloneProjectDialog } from "./CloneProjectDialog"
import { randomColor } from "./section-colors"
import { createProjectStore, type ProjectStore } from "./project/store"
import { createWorktreeDelete, type WorktreeDelete } from "./worktree-delete"
import type { ModeRouter } from "./mode-router"
import { CaffeinationButton } from "./CaffeinationButton"

const place = (state: AgentManagerStateMessage, session: ProjectSessionInfo, local: string) => {
  const wt = state.worktrees.find((item) => item.id === session.worktreeId)
  return wt?.label || wt?.branch || local
}

const activeRun = (status: RunStatus | undefined) => status?.state === "running" || status?.state === "stopping"
const operationBusy = (store: ProjectStore | undefined, id: string) =>
  store?.busy().has(id) || activeRun(store?.runStatuses()[id])

interface Props {
  projects: AgentProjectSnapshot[]
  states: Record<string, AgentManagerStateMessage>
  store?: (projectId: string) => ProjectStore
  stats: Record<string, Record<string, WorktreeGitStats>>
  local: Record<string, LocalGitStats>
  prs: Record<string, Record<string, PRStatus | null>>
  sessions: Record<string, ProjectSessionInfo[]>
  selectedProject?: string
  selection?: string
  currentSessionID?: () => string | undefined
  mode: ModeRouter
  defaultBase?: (projectId: string) => string | undefined
  onCreate?: (projectId: string) => void
  onSelect?: (target: AgentManagerSidebarTarget, restore?: boolean) => void
  onOpenComments?: (projectId: string, worktreeId: string) => void
  onOpenPR?: (projectId: string, worktreeId: string) => void
  busy: (projectId: string, id: string) => boolean
  blocked: (projectId: string, id: string) => boolean
  activityFor: (projectId: string, worktreeId: string | null) => Activity
  sessionActivity: (id: string) => Activity
  bindings: Record<string, string>
  t: LanguageContextValue["t"]
  onSearchRef: (ref: SidebarSearchMenuRef) => void
  onDeleteRef?: (confirm: WorktreeDelete["confirm"]) => void
  onDelete?: (projectId: string, worktreeId: string) => void
  onShortcuts: () => void
  onHistory: (projectId: string) => void
  shortcutMap?: () => Map<string, number>
  /** Cloud execution-location discovery per project id. */
  cloud?: (projectId: string) => CloudScopeView | undefined
  /** Session key currently focused in the hosted chat area. */
  cloudFocusKey?: string
  onSelectCloud?: (target: CloudSidebarTarget) => void
  onCloudRetry?: (projectId: string) => void
}

/** Searchable sessions for one project, placed in their local/worktree context. */
function sessionItems(
  project: AgentProjectSnapshot,
  state: AgentManagerStateMessage,
  sessions: ProjectSessionInfo[],
  t: LanguageContextValue["t"],
  activity: (id: string) => Activity,
): SidebarSearchItem[] {
  return sessions.map((session) => {
    const wt = state.worktrees.find((item) => item.id === session.worktreeId)
    const where = place(state, session, t("agentManager.local"))
    return {
      key: `${project.id}:session:${session.id}`,
      projectId: project.id,
      kind: "session" as const,
      group: "sessions" as const,
      title: session.title || t("agentManager.session.untitled"),
      meta: [project.label, where],
      search: [project.label, where, wt?.branch, session.title, session.id].filter(Boolean).join(" "),
      updatedAt: session.updatedAt,
      state: activity(session.id),
      visible: project.expanded,
      sessionId: session.id,
      location: session.worktreeId ? ("worktree" as const) : ("local" as const),
      worktreeId: session.worktreeId ?? undefined,
    }
  })
}

function cloudItems(
  project: AgentProjectSnapshot,
  scope: CloudScopeView | undefined,
  t: LanguageContextValue["t"],
): SidebarSearchItem[] {
  const items: SidebarSearchItem[] = []
  for (const workspace of scope?.workspaces ?? []) {
    const where = workspace.name ?? t("agentManager.cloud.workspace")
    for (const session of workspace.sessions) {
      // Conflicted rows are not addressable, so they are not searchable.
      if (session.conflict) continue
      items.push({
        key: `${project.id}:cloud:${session.key}`,
        projectId: project.id,
        kind: "cloud",
        group: "sessions",
        title: session.title || t("agentManager.session.untitled"),
        meta: [project.label, where],
        search: [project.label, where, workspace.branch, session.title, session.sessionID].filter(Boolean).join(" "),
        updatedAt: session.updatedAt,
        state: workspace.status?.hasActiveTurn ? "busy" : "idle",
        visible: project.expanded,
        target: {
          projectId: project.id,
          kind: "cloud",
          providerID: session.providerID,
          workspaceID: session.workspaceID,
          organizationID: session.organizationID,
          sessionId: session.sessionID,
        },
      })
    }
  }
  return items
}

export const ProjectList: Component<Props> = (props) => {
  const vscode = useVSCode()
  const dialog = useDialog()
  const select = (target: AgentManagerSidebarTarget, restore?: boolean) => {
    if (props.onSelect) return props.onSelect(target, restore)
    vscode.postMessage({ type: "agentManager.activateSelection", target, restore })
  }
  const stores = new Map<string, ProjectStore>()
  const store = (id: string) => {
    if (!props.projects.some((project) => project.id === id)) return
    if (props.store) return props.store(id)
    const existing = stores.get(id)
    if (existing) return existing
    const value = createProjectStore(id)
    stores.set(id, value)
    return value
  }
  createEffect(() => {
    if (props.store) return
    for (const [id, state] of Object.entries(props.states)) store(id)?.applyState(state)
  })
  const deletion = createWorktreeDelete({
    store,
    project: () => props.selectedProject,
    selection: () => props.selection,
    busy: (projectId, id) => props.busy(projectId, id) || store(projectId)?.busy().has(id) === true,
    blocked: (projectId, id) => props.blocked(projectId, id),
    select,
    remove: (projectId, worktreeId) => {
      props.onDelete?.(projectId, worktreeId)
      vscode.postMessage({ type: "agentManager.deleteWorktree", projectId, worktreeId })
    },
    reveal: (projectId, worktreeId) => {
      if (!props.projects.find((project) => project.id === projectId)?.expanded)
        vscode.postMessage({ type: "agentManager.setProjectExpanded", projectId, expanded: true })
      const state = store(projectId)
      const section = state?.worktrees().find((wt) => wt.id === worktreeId)?.sectionId
      if (section && state?.sections().find((item) => item.id === section)?.collapsed)
        vscode.postMessage({ type: "agentManager.toggleSectionCollapsed", projectId, sectionId: section })
    },
  })
  props.onDeleteRef?.(deletion.confirm)
  const search = createMemo(() => {
    const items: SidebarSearchItem[] = []
    for (const project of props.projects) {
      const state = props.states[project.id]
      if (!state) continue
      const store = props.store?.(project.id)
      const local = props.sessions[project.id]?.filter((session) => session.worktreeId === null) ?? []
      items.push({
        key: `${project.id}:local`,
        projectId: project.id,
        kind: "local",
        group: "contexts",
        title: `${project.label} · ${props.t("agentManager.local")}`,
        meta: props.local[project.id]?.branch ? [props.local[project.id]!.branch] : [],
        search: [project.label, props.t("agentManager.local"), props.local[project.id]?.branch]
          .filter(Boolean)
          .join(" "),
        updatedAt: local.reduce((latest, session) => (session.updatedAt > latest ? session.updatedAt : latest), ""),
        state: props.activityFor(project.id, null),
        visible: project.expanded,
        count: local.length,
      })
      for (const worktree of state.worktrees) {
        const sessions = props.sessions[project.id]?.filter((session) => session.worktreeId === worktree.id) ?? []
        items.push({
          key: `${project.id}:worktree:${worktree.id}`,
          projectId: project.id,
          kind: "worktree",
          group: "contexts",
          title: worktree.label || worktree.branch,
          meta: [project.label, worktree.branch],
          search: [project.label, worktree.label, worktree.branch, worktree.id].filter(Boolean).join(" "),
          updatedAt: worktree.createdAt,
          state: props.activityFor(project.id, worktree.id),
          visible: project.expanded,
          worktreeId: worktree.id,
          count: sessions.length,
          busy: props.busy(project.id, worktree.id) || operationBusy(store, worktree.id),
        })
      }
      items.push(...sessionItems(project, state, props.sessions[project.id] ?? [], props.t, props.sessionActivity))
      items.push(...cloudItems(project, props.cloud?.(project.id), props.t))
    }
    return items
  })
  const current = createMemo(() => {
    const projectId = props.selectedProject
    if (!projectId) return
    const worktree = search().find(
      (item) => item.projectId === projectId && item.kind === "worktree" && item.worktreeId === props.selection,
    )
    if (worktree) return worktree
    // A focused Cloud row owns the chat area, so it is the current item.
    const hosted = props.cloudFocusKey
    if (hosted) {
      const match = search().find(
        (item) => item.projectId === projectId && item.kind === "cloud" && item.key === `${projectId}:cloud:${hosted}`,
      )
      if (match) return match
    }
    // On LOCAL, an open session tab is the active item when there is one, so the
    // menu highlights the same row the sidebar does.
    const session = props.currentSessionID?.()
    if (session) {
      const match = search().find(
        (item) => item.projectId === projectId && item.kind === "session" && item.sessionId === session,
      )
      if (match) return match
    }
    if (props.selection === LOCAL) return search().find((item) => item.key === `${projectId}:local`)
    return undefined
  })
  const selectSearch = (item: SidebarSearchItem) => {
    if (!item.projectId) return
    if (item.kind === "local") return select({ projectId: item.projectId, kind: "local" })
    if (item.kind === "worktree")
      return select({ projectId: item.projectId, kind: "worktree", worktreeId: item.worktreeId })
    if (item.kind === "cloud") return props.onSelectCloud?.(item.target)
    return select({ projectId: item.projectId, kind: "session", sessionId: item.sessionId })
  }
  const newWorktree = (projectId: string) => {
    dialog.show(() => (
      <NewWorktreeDialog
        projectId={projectId}
        projects={() => props.projects}
        activeProjectId={props.selectedProject}
        defaultBase={props.defaultBase}
        onCreate={props.onCreate}
        mode={props.mode}
        onClose={() => dialog.close()}
      />
    ))
  }
  const newProject = () => {
    dialog.show(() => <NewProjectDialog onClose={() => dialog.close()} />)
  }
  const cloneProject = () => {
    dialog.show(() => (
      <CloneProjectDialog roots={props.projects.map((project) => project.root)} onClose={() => dialog.close()} />
    ))
  }
  const [pendingSection, setPendingSection] = createSignal<{ project: string; ids: Set<string> }>()
  const [renamingSection, setRenamingSection] = createSignal<string>()
  createEffect(() => {
    const previous = pendingSection()
    if (!previous) return
    const created = (props.states[previous.project]?.sections ?? []).find((section) => !previous.ids.has(section.id))
    if (!created) return
    setPendingSection(undefined)
    setRenamingSection(created.id)
  })
  const newSection = (projectId: string, worktreeIds?: string[]) => {
    setPendingSection({
      project: projectId,
      ids: new Set((props.states[projectId]?.sections ?? []).map((section) => section.id)),
    })
    vscode.postMessage({
      type: "agentManager.createSection",
      projectId,
      name: props.t("agentManager.section.defaultName"),
      color: randomColor(),
      worktreeIds,
    })
  }
  return (
    <ProjectsSection
      projects={props.projects}
      t={props.t}
      tools={
        <>
          <SidebarSearchMenu
            ref={props.onSearchRef}
            items={search}
            current={current}
            keybind={props.bindings.search ?? ""}
            portal
            labels={{
              search: props.t("agentManager.sidebarSearch.label"),
              scope: props.t("agentManager.sidebarSearch.scope"),
              sessions: props.t("agentManager.section.sessions"),
              contexts: props.t("agentManager.sidebarSearch.contexts"),
              state: (value) => props.t(label(value)),
            }}
            onSelect={selectSearch}
          />
          <CaffeinationButton t={props.t} />
          <TooltipKeybind
            title={props.t("agentManager.shortcuts.title")}
            keybind={props.bindings.showShortcuts ?? ""}
            placement="bottom"
          >
            <IconButton
              icon="keyboard"
              size="small"
              variant="ghost"
              label={props.t("agentManager.shortcuts.title")}
              onClick={props.onShortcuts}
            />
          </TooltipKeybind>
        </>
      }
      onAdd={() => vscode.postMessage({ type: "agentManager.addProject" })}
      onCreateProject={newProject}
      onClone={cloneProject}
      onSelect={(projectId) =>
        // Selecting the project itself returns to where the user left off in it;
        // the extension resolves its persisted target authoritatively.
        select({ projectId, kind: "local" }, true)
      }
      onRemove={(projectId) => vscode.postMessage({ type: "agentManager.removeProject", projectId })}
      onHistory={props.onHistory}
      onNew={newWorktree}
      onCreate={(projectId) => vscode.postMessage({ type: "agentManager.createWorktree", projectId })}
      onSection={(projectId) => newSection(projectId)}
      onSettings={(projectId) => vscode.postMessage({ type: "openSettingsPanel", tab: "agentManager", projectId })}
      bindings={props.bindings}
      baseBranch={(projectId) =>
        props.states[projectId]?.defaultBaseBranch ?? props.local[projectId]?.branch ?? props.t("common.default")
      }
      onExpand={(projectId, expanded) =>
        vscode.postMessage({ type: "agentManager.setProjectExpanded", projectId, expanded })
      }
      onReorder={(order) => vscode.postMessage({ type: "agentManager.setProjectOrder", order })}
      count={(projectId) => {
        const state = props.states[projectId]
        return state ? state.worktrees.length + 1 : undefined
      }}
      body={(project) => (
        <ProjectSidebarBody
          project={project}
          state={props.states[project.id]}
          store={store(project.id)!}
          deletion={deletion}
          busy={(id) => props.busy(project.id, id)}
          blocked={(id) => props.blocked(project.id, id)}
          activityFor={(id) => props.activityFor(project.id, id)}
          stats={props.stats[project.id]}
          local={props.local[project.id]}
          prs={props.prs[project.id]}
          sessions={props.sessions[project.id]}
          selectedProject={props.selectedProject}
          selection={props.selection}
          currentSessionID={props.currentSessionID}
          bindings={props.bindings}
          t={props.t}
          onSelectLocal={(projectId) => select({ projectId, kind: "local" })}
          onSelectWorktree={(projectId, worktreeId) => select({ projectId, kind: "worktree", worktreeId })}
          onOpenComments={props.onOpenComments}
          onOpenPR={props.onOpenPR}
          onSelectCloud={(target) => props.onSelectCloud?.(target)}
          onCloudRetry={() => props.onCloudRetry?.(project.id)}
          cloud={() => props.cloud?.(project.id)}
          cloudFocusKey={props.cloudFocusKey}
          onCreateSection={(worktreeIds) => newSection(project.id, worktreeIds)}
          renamingSection={renamingSection}
          onRenameEnd={() => setRenamingSection(undefined)}
          shortcutMap={props.shortcutMap}
        />
      )}
    />
  )
}
