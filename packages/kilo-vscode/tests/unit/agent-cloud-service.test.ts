import { describe, expect, it } from "bun:test"
import { CloudService } from "../../src/agent-manager/cloud/service"
import { fixture, type FixtureWorkspace } from "./agent-cloud-fixture"

const URL = "https://github.com/acme/app.git"

function ws(id: string, sessions: string[]): FixtureWorkspace {
  return { id, url: URL, name: id, sessions: sessions.map((s) => ({ id: s })) }
}

async function service(
  workspaces: FixtureWorkspace[],
  extra: {
    messages?: Array<{ info: Record<string, unknown>; parts: unknown[] }>
    failMessages?: boolean
    validateAttachments?: boolean
  } = {},
) {
  const backend = fixture({ workspaces, ...extra })
  const holder = { current: backend }
  const posted: Array<Record<string, unknown>> = []
  const listeners = new Set<() => void>()
  const gen = { n: 0 }
  const svc = new CloudService(
    {
      client: async () => holder.current.client,
      generation: () => gen.n,
      onGeneration: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      log: () => {},
    },
    async () => [{ id: "p1", repositoryUrl: "git@github.com:acme/app.git" }],
    (message) => posted.push(message as Record<string, unknown>),
  )
  await svc.refresh()
  const initial = posted.filter((message) => message.type === "agentManager.cloudState").at(-1)
  posted.length = 0
  backend.calls.length = 0
  return {
    svc,
    backend,
    posted,
    initial,
    gen,
    listeners,
    swap: (next: typeof backend) => {
      holder.current = next
    },
  }
}

describe("CloudService interception", () => {
  it("ignores messages for sessions it does not host so local handlers run", async () => {
    const { svc, backend } = await service([ws("w1", ["s1"])])
    expect(await svc.intercept({ type: "sendMessage", sessionID: "local-session", text: "hi" })).toBe(false)
    expect(await svc.intercept({ type: "abort", sessionID: "local-session" })).toBe(false)
    expect(backend.calls).toEqual([])
  })

  it("acknowledges model-usage requests without error for hosted sessions", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    expect(await svc.intercept({ type: "requestSessionModelUsage", sessionID: "s1", requestID: "req1" })).toBe(true)
    expect(posted).toContainEqual({
      type: "sessionModelUsageLoaded",
      sessionID: "s1",
      requestID: "req1",
    })
    expect(posted.some((message) => message.type === "error")).toBe(false)
    expect(backend.calls).toEqual([])
  })

  it("routes a prompt through the attachment selector and never a directory", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    const handled = await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "hello", draftID: "d1" })
    expect(handled).toBe(true)
    const attach = backend.calls.find((call) => call.name === "attach")!
    expect(attach.args.providerID).toBe("cloud")
    const prompt = backend.calls.find((call) => call.name === "session.promptAsync")!
    expect(prompt.args.workspace).toMatch(/^att-/)
    expect(prompt.args.sessionID).toBe("s1")
    expect(prompt.args).not.toHaveProperty("directory")
    // No local editor context / checkpoint inputs on a hosted prompt.
    expect(prompt.args).not.toHaveProperty("editorContext")
    expect(prompt.args).not.toHaveProperty("variant")
    expect(prompt.args.parts).toEqual([{ type: "text", text: "hello" }])
    expect(posted.some((message) => message.type === "sessionStatus" && message.status === "busy")).toBe(true)
  })

  it("keeps the strict Cloud prompt body: kilo model only, no variant", async () => {
    const { svc, backend } = await service([ws("w1", ["s1"])])
    await svc.intercept({
      type: "sendMessage",
      sessionID: "s1",
      text: "hi",
      providerID: "kilo",
      modelID: "kilo-auto/free",
      variant: "high",
      agent: "code",
    })
    const prompt = backend.calls.find((call) => call.name === "session.promptAsync")!
    expect(prompt.args.parts).toEqual([{ type: "text", text: "hi" }])
    expect(prompt.args.model).toEqual({ providerID: "kilo", modelID: "kilo-auto/free" })
    expect(prompt.args.agent).toBe("code")
    expect(prompt.args).not.toHaveProperty("variant")
  })

  it("omits a non-kilo model instead of failing strict prompt parsing", async () => {
    const { svc, backend } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "hi", providerID: "openai", modelID: "gpt-5" })
    const prompt = backend.calls.find((call) => call.name === "session.promptAsync")!
    expect(prompt.args.model).toBeUndefined()
  })

  it("rejects file attachments instead of sending an unparseable prompt", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    await svc.intercept({
      type: "sendMessage",
      sessionID: "s1",
      text: "hi",
      files: [{ mime: "text/plain", url: "file:///tmp/x.txt" }],
    })
    expect(backend.calls.some((call) => call.name === "session.promptAsync")).toBe(false)
    const failure = posted.find((message) => message.type === "sendMessageFailed")!
    expect(String(failure.error)).toContain("attachments")
  })

  it("reports a failed prompt and never falls back to local handling", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    ;(backend.client.session as unknown as { promptAsync: unknown }).promptAsync = async () => {
      throw new Error("boom")
    }
    expect(await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "x", draftID: "d1" })).toBe(true)
    const failure = posted.find((message) => message.type === "sendMessageFailed")!
    expect(failure.text).toBe("x")
    expect(failure.draftID).toBe("d1")
  })

  it("aborts exactly the selected session's turn", async () => {
    const { svc, backend } = await service([ws("w1", ["s1", "s2"])])
    await svc.intercept({ type: "abort", sessionID: "s1", scope: "tree" })
    const aborts = backend.calls.filter((call) => call.name === "session.abort")
    expect(aborts).toHaveLength(1)
    expect(aborts[0]!.args.sessionID).toBe("s1")
    // A hosted Stop never widens to the whole tree.
    expect(aborts[0]!.args.scope).toBe("session")
  })

  it("replies to permissions and questions through the same selector", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "permissionResponse", sessionID: "s1", permissionId: "perm1", response: "once" })
    await svc.intercept({ type: "questionReply", sessionID: "s1", requestID: "q1", answers: [["yes"]] })
    await svc.intercept({ type: "questionReject", sessionID: "s1", requestID: "q2" })
    expect(backend.calls.find((call) => call.name === "permission.reply")!.args.workspace).toMatch(/^att-/)
    expect(backend.calls.find((call) => call.name === "question.reply")!.args.workspace).toMatch(/^att-/)
    expect(backend.calls.find((call) => call.name === "question.reject")!.args.workspace).toMatch(/^att-/)
    expect(posted.some((message) => message.type === "permissionResolved")).toBe(true)
    expect(posted.filter((message) => message.type === "questionResolved")).toHaveLength(2)
  })

  it("loads durable history through the attachment without preparing anything", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "replace" })
    const names = backend.calls.map((call) => call.name)
    expect(names).toContain("session.get")
    expect(names).toContain("session.messages")
    expect(names).not.toContain("session.promptAsync")
    const loaded = posted.find((message) => message.type === "messagesLoaded")!
    expect(loaded.sessionID).toBe("s1")
    expect(loaded.mode).toBe("replace")
    // The history request names only the session; attach must still carry the
    // full compound identity from the catalog row.
    const attach = backend.calls.find((call) => call.name === "attach")!
    expect(attach.args).toMatchObject({ providerID: "cloud", sessionID: "s1" })
  })

  it("releases the loading state and reports a failed history read", async () => {
    const { svc, posted } = await service([ws("w1", ["s1"])], { failMessages: true })
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "replace" })
    const loaded = posted.find((message) => message.type === "messagesLoaded")!
    expect(loaded.sessionID).toBe("s1")
    expect(loaded.messages).toEqual([])
    const error = posted.find((message) => message.type === "error")!
    expect(String(error.message)).toContain("Could not load this Cloud session")
  })

  it("does not re-post an unchanged reconcile transcript", async () => {
    const m1 = { info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "a" }] }
    const m2 = { info: { id: "m2", sessionID: "s1", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "b" }] }
    const { svc, posted, swap } = await service([ws("w1", ["s1"])], { messages: [m1] })
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "reconcile" })
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "reconcile" })
    expect(posted.filter((message) => message.type === "messagesLoaded")).toHaveLength(1)
    // A genuinely new message still publishes.
    swap(fixture({ workspaces: [ws("w1", ["s1"])], messages: [m1, m2] }))
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "reconcile" })
    expect(posted.filter((message) => message.type === "messagesLoaded")).toHaveLength(2)
  })

  it("keeps a background reconcile failure quiet and preserves the transcript", async () => {
    const { svc, posted } = await service([ws("w1", ["s1"])], { failMessages: true })
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "reconcile" })
    expect(posted.some((message) => message.type === "error")).toBe(false)
    expect(posted.some((message) => message.type === "messagesLoaded")).toBe(false)
  })

  it("reports a repeated open failure only once", async () => {
    const { svc, posted } = await service([ws("w1", ["s1"])], { failMessages: true })
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "replace" })
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "replace" })
    expect(posted.filter((message) => message.type === "error")).toHaveLength(1)
  })

  it("re-attaches when a replaced backend no longer knows the cached lease", async () => {
    const { svc, posted, swap } = await service([ws("w1", ["s1"])], { validateAttachments: true })
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "replace" })
    expect(posted.some((message) => message.type === "messagesLoaded")).toBe(true)

    const next = fixture({ workspaces: [ws("w1", ["s1"])], validateAttachments: true })
    swap(next)
    posted.length = 0
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "replace" })

    // The stale lease is dropped and one fresh attach is minted against the new backend.
    expect(next.calls.filter((call) => call.name === "attach")).toHaveLength(1)
    expect(posted.some((message) => message.type === "error")).toBe(false)
    expect(posted.some((message) => message.type === "messagesLoaded")).toBe(true)
  })

  it("renders durable transcript records in the ordinary chat message shape", async () => {
    const { svc, posted } = await service([ws("w1", ["s1"])], {
      messages: [
        {
          info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1234 } },
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    })
    await svc.intercept({ type: "loadMessages", sessionID: "s1", mode: "focus" })
    const loaded = posted.find((message) => message.type === "messagesLoaded") as unknown as {
      mode: string
      messages: Array<{ id: string; parts: unknown[]; createdAt: string }>
    }
    // `focus` reconciles against hosted history rather than reloading locally.
    expect(loaded.mode).toBe("reconcile")
    expect(loaded.messages[0]!.id).toBe("m1")
    expect(loaded.messages[0]!.parts).toEqual([{ type: "text", text: "hello" }])
    expect(loaded.messages[0]!.createdAt).toBe(new Date(1234).toISOString())
    // Reconciles must not churn the session row the chat header renders.
    expect(posted.some((message) => message.type === "sessionCreated")).toBe(false)
  })

  it("consumes unsupported local-only requests for a hosted session without a popup", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    expect(await svc.intercept({ type: "revertSession", sessionID: "s1", messageID: "m1" })).toBe(true)
    expect(await svc.intercept({ type: "compactSession", sessionID: "s1" })).toBe(true)
    expect(await svc.intercept({ type: "requestBackgroundJobs", sessionID: "s1", requestID: "r1" })).toBe(true)
    expect(backend.calls).toEqual([])
    // Probes must not raise global error banners on a Cloud session.
    expect(posted.filter((message) => message.type === "error")).toEqual([])
  })

  it("never resolves a conflicted native session ID", async () => {
    const { svc, backend } = await service([ws("w1", ["dup"]), ws("w2", ["dup"])])
    expect(svc.find(undefined, "dup")).toBeUndefined()
    // Not hosted → falls through to local handling; nothing reaches the wire.
    expect(await svc.intercept({ type: "sendMessage", sessionID: "dup", text: "x" })).toBe(false)
    expect(backend.calls).toEqual([])
  })

  it("binds selection to the full compound identity, not the session ID alone", async () => {
    const { svc } = await service([ws("w1", ["s1"]), ws("w2", ["s2"])])
    const good = { projectId: "p1", providerID: "cloud", workspaceID: "w1", sessionID: "s1" }
    expect(svc.binding(good)).toBeDefined()
    expect(svc.binding({ ...good, workspaceID: "w2" })).toBeUndefined()
    expect(svc.binding({ ...good, providerID: "other" })).toBeUndefined()
    expect(svc.binding({ ...good, projectId: "p2" })).toBeUndefined()
  })
})

describe("CloudService lifecycle", () => {
  it("detach releases views without aborting remote work", async () => {
    const { svc, backend } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "go" })
    backend.calls.length = 0
    svc.detach()
    await Promise.resolve()
    await Promise.resolve()
    const names = backend.calls.map((call) => call.name)
    expect(names).toContain("detach")
    expect(names).not.toContain("session.abort")
  })

  it("stays restartable after the panel closes", async () => {
    const { svc, backend } = await service([ws("w1", ["s1"])])
    svc.detach()
    backend.calls.length = 0
    await svc.refresh()
    expect(backend.calls.some((call) => call.name === "listWorkspaces")).toBe(true)
  })

  it("resumes discovery after the panel is hidden and shown again", async () => {
    const { svc, backend } = await service([ws("w1", ["s1"])])
    svc.start()
    await svc.refresh()
    svc.stop()
    backend.calls.length = 0
    svc.start()
    await svc.refresh()
    expect(backend.calls.some((call) => call.name === "listWorkspaces")).toBe(true)
    svc.dispose()
  })

  it("invalidates attachments and reconciles when the backend is replaced", async () => {
    const { svc, backend, gen, listeners } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "a" })
    const first = backend.calls.filter((call) => call.name === "attach").length
    gen.n++
    for (const listener of listeners) listener()
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "b" })
    expect(backend.calls.filter((call) => call.name === "attach").length).toBe(first + 1)
    expect(backend.calls.some((call) => call.name === "listWorkspaces")).toBe(true)
  })

  it("pushes catalog state to the webview with compound row keys", async () => {
    const { initial, posted, svc } = await service([ws("w1", ["s1"])])
    const message = initial as unknown as {
      scopes: Array<{ workspaces: Array<{ sessions: Array<{ key: string }> }> }>
    }
    expect(message.scopes[0]!.workspaces[0]!.sessions[0]!.key).toBe(JSON.stringify(["cloud", "w1", "s1"]))
    // Identical catalogs are not re-pushed; the sidebar must not blink on polls.
    svc.push()
    expect(posted.filter((item) => item.type === "agentManager.cloudState")).toHaveLength(0)
  })
})

describe("CloudService hosted events", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

  it("subscribes to the attachment-scoped streams, never the global feed", async () => {
    const { svc, backend } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "go" })
    await tick()
    const native = backend.calls.find((call) => call.name === "event.subscribe")!
    const system = backend.calls.find((call) => call.name === "cloudAgent.systemEvents")!
    expect(native.args.workspace).toMatch(/^att-/)
    expect(system.args.workspace).toBe(native.args.workspace)
    svc.dispose()
  })

  it("relays typed native events for the hosted session through the ordinary mapper", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "go" })
    await tick()
    posted.length = 0
    for (const push of backend.feeds.native) {
      push({ payload: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })
    }
    await tick()
    expect(posted).toContainEqual({ type: "sessionStatus", sessionID: "s1", status: "busy" })
    svc.dispose()
  })

  it("does not relay an event for a session it does not host", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "go" })
    await tick()
    posted.length = 0
    for (const push of backend.feeds.native) {
      push({ payload: { type: "session.status", properties: { sessionID: "other", status: { type: "busy" } } } })
    }
    await tick()
    expect(posted.filter((message) => message.type === "sessionStatus")).toEqual([])
    svc.dispose()
  })

  it("treats an unrecognized native frame as a trigger and re-reads typed state", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "go" })
    await tick()
    backend.calls.length = 0
    posted.length = 0
    for (const push of backend.feeds.native) push({ payload: { type: "kilo.native.fence", opaque: { x: 1 } } })
    await Bun.sleep(5100)
    // State comes from the authoritative reconcile, never from the frame payload.
    expect(backend.calls.map((call) => call.name)).toContain("session.messages")
    const reconcile = posted.find((message) => message.type === "messagesLoaded")!
    expect(reconcile.mode).toBe("reconcile")
    expect(JSON.stringify(posted)).not.toContain("opaque")
    svc.dispose()
  }, 15_000)

  it("treats system-feed frames as triggers for a passive status re-read", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    await svc.intercept({ type: "sendMessage", sessionID: "s1", text: "go" })
    await tick()
    backend.calls.length = 0
    for (const push of backend.feeds.system) push({ payload: { type: "cloud.status", status: "totally-made-up" } })
    await Bun.sleep(10100)
    expect(backend.calls.some((call) => call.name === "getWorkspaceStatus")).toBe(true)
    expect(JSON.stringify(posted)).not.toContain("totally-made-up")
    svc.dispose()
  }, 15_000)
})

describe("CloudService local-capability boundary", () => {
  it("refuses @git-changes for a hosted session instead of reading the local checkout", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    expect(await svc.intercept({ type: "requestGitChangesContext", requestId: "r1", sessionID: "s1" })).toBe(true)
    expect(posted).toContainEqual({
      type: "gitChangesContextError",
      requestId: "r1",
      error: "Git changes are not available for Cloud sessions.",
    })
    expect(backend.calls).toEqual([])
  })

  it("refuses a sessionless @git-changes request while a hosted chat is focused", async () => {
    const { svc, posted } = await service([ws("w1", ["s1"])])
    svc.hold({ projectId: "p1", providerID: "cloud", workspaceID: "w1", sessionID: "s1" })
    expect(await svc.intercept({ type: "requestGitChangesContext", requestId: "r2" })).toBe(true)
    expect(posted.some((message) => message.type === "gitChangesContextError" && message.requestId === "r2")).toBe(true)
  })

  it("lets local @git-changes through when no hosted chat is focused", async () => {
    const { svc, posted } = await service([ws("w1", ["s1"])])
    expect(await svc.intercept({ type: "requestGitChangesContext", requestId: "r3", sessionID: "local-1" })).toBe(false)
    expect(await svc.intercept({ type: "requestGitChangesContext", requestId: "r4" })).toBe(false)
    expect(posted).toEqual([])
  })

  it("hands git-changes back to local targets after a local selection", async () => {
    const { svc } = await service([ws("w1", ["s1"])])
    svc.hold({ projectId: "p1", providerID: "cloud", workspaceID: "w1", sessionID: "s1" })
    await svc.intercept({ type: "agentManager.activateSelection", target: { projectId: "p1", kind: "local" } })
    expect(await svc.intercept({ type: "requestGitChangesContext", requestId: "r5" })).toBe(false)
  })
})

describe("CloudService local transcript and composer actions", () => {
  const focus = (svc: CloudService) =>
    svc.hold({ projectId: "p1", providerID: "cloud", workspaceID: "w1", sessionID: "s1" })

  it("answers composer file mentions with an empty result instead of searching the local workspace", async () => {
    const { svc, backend, posted } = await service([ws("w1", ["s1"])])
    expect(await svc.intercept({ type: "requestFileSearch", requestId: "f1", query: "App", sessionID: "s1" })).toBe(
      true,
    )
    focus(svc)
    expect(await svc.intercept({ type: "requestFileSearch", requestId: "f2", query: "App" })).toBe(true)
    const results = posted.filter((message) => message.type === "fileSearchResult")
    expect(results.map((message) => [message.requestId, message.paths])).toEqual([
      ["f1", []],
      ["f2", []],
    ])
    expect(backend.calls).toEqual([])
  })

  it("drops openFile and openChanges for a hosted chat so no local file or diff opens", async () => {
    const { svc, backend } = await service([ws("w1", ["s1"])])
    expect(await svc.intercept({ type: "openFile", filePath: "/etc/passwd", sessionID: "s1" })).toBe(true)
    focus(svc)
    expect(await svc.intercept({ type: "openChanges", turnId: "m1" })).toBe(true)
    expect(backend.calls).toEqual([])
  })

  it("leaves the same requests to local handlers for non-hosted sessions", async () => {
    const { svc } = await service([ws("w1", ["s1"])])
    expect(await svc.intercept({ type: "openFile", filePath: "/repo/a.ts", sessionID: "local-1" })).toBe(false)
    expect(await svc.intercept({ type: "openChanges", turnId: "m1" })).toBe(false)
    expect(await svc.intercept({ type: "requestFileSearch", requestId: "f", query: "a" })).toBe(false)
  })
})
