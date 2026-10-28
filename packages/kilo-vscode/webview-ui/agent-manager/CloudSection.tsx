/**
 * Cloud execution location for one registered project in the Agent Manager
 * sidebar: an explicit row nested alongside Local/worktrees, listing each
 * authorized workspace independently with its existing root sessions.
 *
 * Renders loading, signed-out, empty, and error states with accessible
 * labels; shows only supported compute/billing status (never invented data).
 * No local git-stat skeleton, branch subtitle, worktree actions, or local
 * filesystem tooltips are rendered here.
 */

import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import type { CloudScopeView, CloudSidebarTarget, CloudWorkspaceView } from "./cloud-types"
import { cloudNavId } from "./navigate"

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)

interface Props {
  projectId: string
  scope?: CloudScopeView
  /** Session key currently opened in the chat area, if any. */
  focusKey?: string
  /** Numeric shortcut badges keyed by the same nav ids as Local/worktrees. */
  shortcuts?: () => Map<string, number>
  onSelect: (target: CloudSidebarTarget) => void
  onRetry: () => void
  onToggle: (open: boolean) => void
  /** Labels from the shared language context. */
  t: (key: string, values?: Record<string, string | number>) => string
}

export const CloudSection: Component<Props> = (props) => {
  const scope = createMemo(() => props.scope)
  const workspaces = createMemo(() => scope()?.workspaces ?? [])
  const busy = createMemo(() => scope()?.status === "loading")
  const [open, setOpen] = createSignal(true)
  const toggle = () => {
    const next = !open()
    setOpen(next)
    props.onToggle(next)
  }
  const statusLine = (workspace: CloudWorkspaceView): string => {
    const status = workspace.status
    if (status?.deleting) return props.t("agentManager.cloud.deleting")
    if (status) return props.t("agentManager.cloud.compute", { state: String(status.compute) })
    return props.t("agentManager.cloud.computeUnknown")
  }
  const costLine = (workspace: CloudWorkspaceView): string | undefined => {
    const rate = workspace.status?.rateMicrodollarsPerHour
    if (rate === undefined) return undefined
    // Supported billing display: the typed workspace status rate only.
    return props.t("agentManager.cloud.rate", { rate: (rate / 1_000_000).toFixed(2) })
  }

  return (
    <Show when={scope()}>
      {(resolved) => (
        <div class="am-cloud" data-component="am-cloud" data-state={resolved().status}>
          <button
            type="button"
            class="am-cloud-header"
            aria-expanded={open()}
            onClick={toggle}
            data-testid={`cloud-header-${resolved().projectId}`}
          >
            <Icon name="providers" size="small" />
            <span class="am-cloud-title">{props.t("agentManager.cloud.title")}</span>
            <Show when={busy()}>
              <span class="am-cloud-spin" role="status" aria-label={props.t("agentManager.cloud.loading")} />
            </Show>
            <Show when={resolved().status === "signed_out"}>
              <span class="am-cloud-scope">{props.t("agentManager.cloud.signedOut")}</span>
            </Show>
            <Show when={resolved().conflictCount}>
              <span class="am-cloud-scope">
                {props.t("agentManager.cloud.conflict", { count: Number(resolved().conflictCount) })}
              </span>
            </Show>
          </button>

          <Show when={open()}>
            <Show when={resolved().message && resolved().status !== "loading"}>
              <div class="am-cloud-error" role="alert">
                <span class="am-cloud-error-text">{resolved().message}</span>
                <Button variant="secondary" size="small" onClick={props.onRetry}>
                  {props.t("agentManager.cloud.retry")}
                </Button>
              </div>
            </Show>
            <Show when={resolved().degraded}>
              <div class="am-cloud-note" role="status">
                {props.t("agentManager.cloud.degraded")}
              </div>
            </Show>
            <Show when={resolved().status === "signed_out"}>
              <div class="am-cloud-empty" role="status">
                {props.t("agentManager.cloud.signedOutBody")}
              </div>
            </Show>
            <Show when={resolved().empty}>
              <div class="am-cloud-empty" role="status">
                {props.t("agentManager.cloud.empty")}
              </div>
            </Show>
            <For each={workspaces()}>
              {(workspace) => (
                <div class="am-cloud-workspace" data-testid={`cloud-workspace-${workspace.workspaceID}`}>
                  <div class="am-cloud-ws-head" title={workspace.name ?? workspace.workspaceID}>
                    <span class="am-cloud-ws-name">{workspace.name ?? props.t("agentManager.cloud.workspace")}</span>
                    <Show when={workspace.branch}>
                      <span class="am-cloud-ws-branch">{workspace.branch}</span>
                    </Show>
                    <span class="am-cloud-ws-status" role="status">
                      {statusLine(workspace)}
                    </span>
                    <Show when={costLine(workspace)}>
                      <span class="am-cloud-ws-rate">{costLine(workspace)}</span>
                    </Show>
                  </div>
                  <For each={workspace.sessions}>
                    {(session) => {
                      const navId = () =>
                        cloudNavId(props.projectId, workspace.providerID, workspace.workspaceID, session.sessionID)
                      return (
                        <button
                          type="button"
                          class="am-cloud-session"
                          classList={{
                            "am-cloud-session-active": props.focusKey === session.key,
                            "am-cloud-session-disabled": session.conflict === true || props.scope?.status !== "ready",
                          }}
                          disabled={session.conflict === true || props.scope?.status !== "ready"}
                          data-sidebar-id={navId()}
                          title={session.title ?? session.sessionID}
                          onClick={() =>
                            props.onSelect({
                              projectId: props.projectId,
                              kind: "cloud",
                              providerID: session.providerID,
                              workspaceID: session.workspaceID,
                              organizationID: session.organizationID,
                              sessionId: session.sessionID,
                            })
                          }
                        >
                          <span class="am-cloud-session-title">{session.title ?? session.sessionID}</span>
                          <Show when={session.conflict}>
                            <span class="am-cloud-conflict">{props.t("agentManager.cloud.conflictSession")}</span>
                          </Show>
                          <Show when={props.shortcuts?.().get(navId())}>
                            {(shortcut) => (
                              <span class="am-shortcut-badge">
                                {isMac ? "⌘" : "Ctrl+"}
                                {shortcut()}
                              </span>
                            )}
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                  <Show when={workspace.sessions.length === 0}>
                    <div class="am-cloud-empty" role="status">
                      {props.t("agentManager.cloud.noRootSessions")}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      )}
    </Show>
  )
}
