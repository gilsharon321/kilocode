import assert from "node:assert/strict"
import { Window } from "happy-dom"

const window = new Window({ url: "https://kilo.test" })
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLHeadElement: window.HTMLHeadElement,
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  Event: window.Event,
  Element: window.Element,
  SVGElement: window.SVGElement,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
})

const { render } = await import("solid-js/web")
const { createSignal } = await import("solid-js")
const { CloudSection } = await import("../../webview-ui/agent-manager/CloudSection")

type Scope = import("../../webview-ui/agent-manager/cloud-types").CloudScopeView
type Target = import("../../webview-ui/agent-manager/cloud-types").CloudSidebarTarget

const t = (key: string, values?: Record<string, string | number>) => (values ? `${key}|${JSON.stringify(values)}` : key)

function session(id: string, workspaceID: string, extra: Record<string, unknown> = {}) {
  return {
    projectId: "p1",
    providerID: "cloud",
    workspaceID,
    sessionID: id,
    key: JSON.stringify(["cloud", workspaceID, id]),
    title: `title ${id}`,
    createdAt: "",
    updatedAt: "",
    ...extra,
  }
}

const picked: Target[] = []
let retried = 0
const [scope, setScope] = createSignal<Scope | undefined>(undefined)
const [focus, setFocus] = createSignal<string | undefined>(undefined)

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <CloudSection
      projectId="p1"
      scope={scope()}
      focusKey={focus()}
      onSelect={(target) => picked.push(target)}
      onRetry={() => retried++}
      onToggle={() => {}}
      t={t}
    />
  ),
  root,
)

const text = () => root.textContent ?? ""
const rows = () => [...root.querySelectorAll<HTMLButtonElement>(".am-cloud-session")]

// Nothing renders before discovery has produced a scope.
assert.equal(root.querySelector(".am-cloud"), null)

// Loading is announced accessibly.
setScope({ projectId: "p1", status: "loading", empty: false, workspaces: [] })
assert.ok(root.querySelector('[role="status"][aria-label="agentManager.cloud.loading"]'))

// Signed out is explicit, not an empty list.
setScope({ projectId: "p1", status: "signed_out", empty: false, message: "unauthorized", workspaces: [] })
assert.ok(text().includes("agentManager.cloud.signedOutBody"))
assert.ok(!text().includes("agentManager.cloud.empty"))
assert.equal(root.querySelector(".am-cloud-error [role]"), null)

// Error shows the message and a working retry.
setScope({ projectId: "p1", status: "error", empty: false, message: "backend unavailable", workspaces: [] })
assert.ok(text().includes("backend unavailable"))
root.querySelector<HTMLButtonElement>(".am-cloud-error button")!.click()
assert.equal(retried, 1)

// Ready but empty.
setScope({ projectId: "p1", status: "ready", empty: true, workspaces: [] })
assert.ok(text().includes("agentManager.cloud.empty"))

// Two independent workspaces, one with a conflicted session, a degraded notice.
setScope({
  projectId: "p1",
  status: "ready",
  empty: false,
  degraded: true,
  conflictCount: 1,
  workspaces: [
    {
      providerID: "cloud",
      workspaceID: "w1",
      key: JSON.stringify(["cloud", "w1"]),
      name: "Workspace One",
      branch: "main",
      status: {
        compute: "sleeping",
        billingBlocked: false,
        activeSessions: 0,
        hasActiveTurn: false,
        deleting: false,
        rateMicrodollarsPerHour: 250000,
      },
      sessions: [session("s1", "w1"), session("dup", "w1", { conflict: true })],
    },
    {
      providerID: "cloud",
      workspaceID: "w2",
      organizationID: "org-1",
      key: JSON.stringify(["cloud", "w2"]),
      // The catalog copies the workspace's organization onto every session row.
      sessions: [
        session("dup", "w2", { conflict: true, organizationID: "org-1" }),
        session("s3", "w2", { organizationID: "org-1" }),
      ],
    },
  ],
})
assert.ok(text().includes("agentManager.cloud.degraded"))
assert.equal(root.querySelectorAll(".am-cloud-workspace").length, 2)
assert.ok(text().includes("Workspace One"))
assert.ok(text().includes("main"))
// Supported compute/billing status only; the rate is derived from the typed value.
assert.ok(text().includes('"state":"sleeping"'))
assert.ok(text().includes('"rate":"0.25"'))
// A workspace without status never invents compute or cost text.
const second = root.querySelector('[data-testid="cloud-workspace-w2"]')!
assert.ok(second.textContent!.includes("agentManager.cloud.computeUnknown"))
assert.ok(!second.textContent!.includes("agentManager.cloud.rate"))

// Selecting a session emits the full compound identity, including organization provenance.
const s3 = rows().find((row) => row.textContent!.includes("title s3"))!
s3.click()
assert.deepEqual(picked.at(-1), {
  projectId: "p1",
  kind: "cloud",
  providerID: "cloud",
  workspaceID: "w2",
  organizationID: "org-1",
  sessionId: "s3",
})

// Same-named session IDs in different workspaces stay distinct rows and are disabled.
const dups = rows().filter((row) => row.textContent!.includes("title dup"))
assert.equal(dups.length, 2)
assert.ok(dups.every((row) => row.disabled))
const before = picked.length
dups.forEach((row) => row.click())
assert.equal(picked.length, before, "conflicted rows must not be selectable")
assert.notEqual(
  dups[0]!.getAttribute("data-sidebar-id"),
  dups[1]!.getAttribute("data-sidebar-id"),
  "row identities must differ across workspaces",
)

// Active highlighting follows the compound key, not the raw session ID.
setFocus(JSON.stringify(["cloud", "w1", "s1"]))
const active = rows().filter((row) => row.classList.contains("am-cloud-session-active"))
assert.equal(active.length, 1)
assert.ok(active[0]!.textContent!.includes("title s1"))
setFocus(JSON.stringify(["cloud", "w2", "s1"]))
assert.equal(rows().filter((row) => row.classList.contains("am-cloud-session-active")).length, 0)

// A workspace with no root sessions says so.
setScope({
  projectId: "p1",
  status: "ready",
  empty: false,
  workspaces: [{ providerID: "cloud", workspaceID: "w9", key: "k", sessions: [] }],
})
assert.ok(text().includes("agentManager.cloud.noRootSessions"))

dispose()
