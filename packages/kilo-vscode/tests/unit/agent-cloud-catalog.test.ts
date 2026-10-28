import { describe, expect, it } from "bun:test"
import { CloudCatalog } from "../../src/agent-manager/cloud/catalog"
import { fixture, type FixtureWorkspace } from "./agent-cloud-fixture"

const URL = "https://github.com/acme/app.git"

function ws(id: string, sessions: string[], extra: Partial<FixtureWorkspace> = {}): FixtureWorkspace {
  return { id, url: URL, name: id, sessions: sessions.map((s) => ({ id: s, title: s })), ...extra }
}

function catalog(
  backend: ReturnType<typeof fixture>,
  projects = [{ id: "p1", repositoryUrl: "git@github.com:acme/app.git" }],
) {
  return new CloudCatalog({ client: async () => backend.client, projects: async () => projects, log: () => {} })
}

describe("CloudCatalog discovery", () => {
  it("matches workspaces to projects by canonical repository and lists root sessions", async () => {
    const backend = fixture({
      workspaces: [ws("w1", ["s1", "s2"]), { ...ws("w2", ["x"]), url: "https://github.com/acme/other" }],
    })
    const cat = catalog(backend)
    await cat.refresh()
    const scope = cat.snapshot().scopes.find((item) => item.projectId === "p1")!
    expect(scope.status).toBe("ready")
    expect(scope.workspaces.map((item) => item.workspaceID)).toEqual(["w1"])
    expect(scope.workspaces[0]!.sessions.map((item) => item.sessionID).sort()).toEqual(["s1", "s2"])
  })

  it("follows workspace and session cursors across pages", async () => {
    const backend = fixture({
      page: 2,
      workspaces: [ws("w1", ["a", "b", "c", "d", "e"]), ws("w2", []), ws("w3", []), ws("w4", []), ws("w5", [])],
    })
    const cat = catalog(backend)
    await cat.refresh()
    const scope = cat.snapshot().scopes[0]!
    expect(scope.workspaces).toHaveLength(5)
    expect(scope.workspaces.find((item) => item.workspaceID === "w1")!.sessions).toHaveLength(5)
  })

  it("stops on a repeated cursor instead of looping forever", async () => {
    const backend = fixture({ page: 1, loop: true, workspaces: [ws("w1", []), ws("w2", [])] })
    const cat = catalog(backend)
    await cat.refresh()
    // Bounded: a hostile server cannot make one pass unbounded.
    expect(backend.calls.filter((call) => call.name === "listWorkspaces").length).toBeLessThan(10)
  })

  it("keeps independent workspaces for the same repository distinct", async () => {
    const backend = fixture({ workspaces: [ws("w1", ["s1"]), ws("w2", ["s2"], { branch: "feature" })] })
    const cat = catalog(backend)
    await cat.refresh()
    const rows = cat.snapshot().scopes[0]!.workspaces
    expect(rows.map((item) => item.workspaceID).sort()).toEqual(["w1", "w2"])
    expect(rows.find((item) => item.workspaceID === "w2")!.branch).toBe("feature")
  })

  it("enumerates personal and every authorized organization scope explicitly", async () => {
    const backend = fixture({
      orgs: ["org-1", "org-2"],
      workspaces: [ws("mine", ["a"]), ws("o1", ["b"], { org: "org-1" }), ws("o2", ["c"], { org: "org-2" })],
    })
    const cat = catalog(backend)
    await cat.refresh()
    const passes = backend.calls
      .filter((call) => call.name === "listWorkspaces")
      .map((call) => call.args.organizationID)
    expect(passes).toEqual([undefined, "org-1", "org-2"])
    const rows = cat.snapshot().scopes[0]!.workspaces
    expect(rows.map((item) => item.workspaceID).sort()).toEqual(["mine", "o1", "o2"])
    // Provenance is retained so later reads carry the right organization.
    expect(rows.find((item) => item.workspaceID === "o2")!.organizationID).toBe("org-2")
    expect(rows.find((item) => item.workspaceID === "mine")!.organizationID).toBeUndefined()
  })

  it("skips deleted workspaces but keeps deleting ones visible", async () => {
    const backend = fixture({
      workspaces: [ws("gone", ["a"], { deletion: "deleted" }), ws("going", ["b"], { deletion: "deleting" })],
    })
    const cat = catalog(backend)
    await cat.refresh()
    expect(cat.snapshot().scopes[0]!.workspaces.map((item) => item.workspaceID)).toEqual(["going"])
  })

  it("reports an empty ready state without inventing rows", async () => {
    const backend = fixture({ workspaces: [] })
    const cat = catalog(backend)
    await cat.refresh()
    const scope = cat.snapshot().scopes[0]!
    expect(scope.status).toBe("ready")
    expect(scope.empty).toBe(true)
    expect(scope.workspaces).toEqual([])
  })

  it("never lists a workspace for a project without a readable origin", async () => {
    const backend = fixture({ workspaces: [ws("w1", ["a"])] })
    const cat = catalog(backend, [{ id: "p1", repositoryUrl: undefined }])
    await cat.refresh()
    expect(cat.snapshot().scopes[0]!.workspaces).toEqual([])
  })

  it("publishes a per-project scope even when the backend is unavailable", async () => {
    const cat = new CloudCatalog({
      client: async () => {
        throw new Error("offline")
      },
      projects: async () => [{ id: "p1", repositoryUrl: URL }],
      log: () => {},
    })
    await cat.refresh()
    const scope = cat.snapshot().scopes.find((item) => item.projectId === "p1")!
    // The Cloud location must render an error rather than disappear.
    expect(scope.status).toBe("error")
    expect(scope.message).toBeTruthy()
  })

  it("keeps the last good catalog when every pass fails", async () => {
    const good = fixture({ workspaces: [ws("w1", ["s1"])] })
    let current = good
    const cat = new CloudCatalog({
      client: async () => current.client,
      projects: async () => [{ id: "p1", repositoryUrl: URL }],
      log: () => {},
    })
    await cat.refresh()
    current = fixture({ workspaces: [], failWorkspaces: true })
    await cat.refresh()
    const scope = cat.snapshot().scopes[0]!
    // Rows survive an outage; the location degrades instead of reloading empty.
    expect(scope.status).toBe("ready")
    expect(scope.degraded).toBe(true)
    expect(scope.workspaces.map((item) => item.workspaceID)).toEqual(["w1"])
  })
})

describe("CloudCatalog authorization", () => {
  it("surfaces signed-out instead of a successful empty catalog", async () => {
    const backend = fixture({ workspaces: [ws("w1", ["a"])], denied: ["personal"] })
    const cat = catalog(backend)
    await cat.refresh()
    const scope = cat.snapshot().scopes[0]!
    expect(scope.status).toBe("signed_out")
    expect(scope.empty).toBe(false)
    expect(scope.message).toBeTruthy()
  })

  it("keeps authorized scopes and flags a denied one as degraded", async () => {
    const backend = fixture({
      orgs: ["org-1"],
      denied: ["org-1"],
      workspaces: [ws("mine", ["a"]), ws("o1", ["b"], { org: "org-1" })],
    })
    const cat = catalog(backend)
    await cat.refresh()
    const scope = cat.snapshot().scopes[0]!
    expect(scope.status).toBe("ready")
    expect(scope.degraded).toBe(true)
    expect(scope.workspaces.map((item) => item.workspaceID)).toEqual(["mine"])
    // A degraded catalog must never read as a clean empty one.
    expect(scope.empty).toBe(false)
  })

  it("drops rows after an external deletion on the next reconcile", async () => {
    const workspaces = [ws("w1", ["a", "b"])]
    const backend = fixture({ workspaces })
    const cat = catalog(backend)
    await cat.refresh()
    expect(cat.snapshot().scopes[0]!.workspaces[0]!.sessions).toHaveLength(2)
    workspaces[0]!.sessions.pop()
    await cat.refresh()
    expect(cat.snapshot().scopes[0]!.workspaces[0]!.sessions.map((item) => item.sessionID)).toEqual(["a"])
  })
})

describe("CloudCatalog identity conflicts", () => {
  it("disables a native session ID reported by two workspaces instead of guessing", async () => {
    const backend = fixture({ workspaces: [ws("w1", ["dup", "ok"]), ws("w2", ["dup"])] })
    const cat = catalog(backend)
    await cat.refresh()
    const scope = cat.snapshot().scopes[0]!
    const rows = scope.workspaces.flatMap((item) => item.sessions)
    expect(rows.filter((item) => item.sessionID === "dup").every((item) => item.conflict === true)).toBe(true)
    expect(rows.find((item) => item.sessionID === "ok")!.conflict).toBeUndefined()
    expect(scope.conflictCount).toBe(1)
    expect(scope.empty).toBe(false)
  })
})

describe("CloudCatalog stale refresh", () => {
  it("shares one pass between concurrent refreshes", async () => {
    const backend = fixture({ workspaces: [ws("w1", ["a"])] })
    const cat = catalog(backend)
    await Promise.all([cat.refresh(), cat.refresh(), cat.refresh()])
    expect(backend.calls.filter((call) => call.name === "listWorkspaces")).toHaveLength(1)
  })

  it("makes no write or preparation calls while discovering", async () => {
    const backend = fixture({ workspaces: [ws("w1", ["a"])] })
    const cat = catalog(backend)
    await cat.refresh()
    const names = new Set(backend.calls.map((call) => call.name))
    for (const forbidden of ["attach", "session.promptAsync", "session.abort", "session.messages"]) {
      expect(names.has(forbidden)).toBe(false)
    }
  })
})
