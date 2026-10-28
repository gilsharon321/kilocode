import { describe, expect, it } from "bun:test"
import { AttachmentRegistry, HostedUnavailableError } from "../../src/agent-manager/cloud/attachments"
import type { CloudRef } from "../../webview-ui/agent-manager/cloud-types"
import { fixture } from "./agent-cloud-fixture"

const ref: CloudRef = { projectId: "p1", providerID: "cloud", workspaceID: "w1", sessionID: "s1" }

function registry(backend: ReturnType<typeof fixture>, now = { t: 0 }, gen = { n: 0 }) {
  return {
    now,
    gen,
    reg: new AttachmentRegistry(
      { client: async () => backend.client, generation: () => gen.n, log: () => {} },
      () => now.t,
    ),
  }
}

describe("AttachmentRegistry", () => {
  it("reuses a valid attachment instead of minting another", async () => {
    const backend = fixture({ workspaces: [] })
    const { reg } = registry(backend)
    const a = await reg.acquire(ref)
    const b = await reg.acquire(ref)
    expect(b.attachmentID).toBe(a.attachmentID)
    expect(backend.calls.filter((call) => call.name === "attach")).toHaveLength(1)
  })

  it("shares one in-flight attach between concurrent acquires", async () => {
    const backend = fixture({ workspaces: [] })
    const { reg } = registry(backend)
    const leases = await Promise.all([reg.acquire(ref), reg.acquire(ref), reg.acquire(ref)])
    expect(new Set(leases.map((lease) => lease.attachmentID)).size).toBe(1)
    expect(backend.calls.filter((call) => call.name === "attach")).toHaveLength(1)
  })

  it("renews before expiry rather than returning a stale attachment", async () => {
    const backend = fixture({ workspaces: [], attachExpiresIn: 60_000 })
    const { reg, now } = registry(backend, { t: Date.now() })
    const first = await reg.acquire(ref)
    // Move inside the renewal skew window.
    now.t = first.expiresAt - 1_000
    const second = await reg.acquire(ref)
    expect(second.attachmentID).not.toBe(first.attachmentID)
  })

  it("keeps different compound targets on different attachments", async () => {
    const backend = fixture({ workspaces: [] })
    const { reg } = registry(backend)
    const a = await reg.acquire(ref)
    const b = await reg.acquire({ ...ref, workspaceID: "w2" })
    const c = await reg.acquire({ ...ref, providerID: "other" })
    expect(new Set([a.attachmentID, b.attachmentID, c.attachmentID]).size).toBe(3)
  })

  it("passes organization provenance to attach", async () => {
    const backend = fixture({ workspaces: [] })
    const { reg } = registry(backend)
    await reg.acquire({ ...ref, organizationID: "org-9" })
    expect(backend.calls.find((call) => call.name === "attach")!.args.organizationID).toBe("org-9")
  })

  it("detaches only after the last view releases", async () => {
    const backend = fixture({ workspaces: [] })
    const { reg } = registry(backend)
    await reg.acquire(ref)
    await reg.acquire(ref)
    reg.release(ref)
    expect(backend.calls.some((call) => call.name === "detach")).toBe(false)
    reg.release(ref)
    await Promise.resolve()
    await Promise.resolve()
    expect(backend.calls.filter((call) => call.name === "detach")).toHaveLength(1)
  })

  it("invalidates every lease when the backend is replaced", async () => {
    const backend = fixture({ workspaces: [] })
    const { reg, gen } = registry(backend)
    const before = await reg.acquire(ref)
    gen.n++
    const after = await reg.acquire(ref)
    expect(after.attachmentID).not.toBe(before.attachmentID)
  })

  it("fails closed after a refused attach and does not retry blindly", async () => {
    const backend = fixture({ workspaces: [] })
    ;(backend.client.sessionHost as unknown as { attach: unknown }).attach = async () => {
      backend.calls.push({ name: "attach", args: {} })
      throw Object.assign(new Error("404 deleted"), { data: { body: { message: "session deleted" } } })
    }
    const { reg } = registry(backend)
    await expect(reg.acquire(ref)).rejects.toThrow()
    await expect(reg.acquire(ref)).rejects.toBeInstanceOf(HostedUnavailableError)
    expect(backend.calls.filter((call) => call.name === "attach")).toHaveLength(1)
  })

  it("rejects an attach response without an attachment ID", async () => {
    const backend = fixture({ workspaces: [] })
    ;(backend.client.sessionHost as unknown as { attach: unknown }).attach = async () => ({ data: {} })
    const { reg } = registry(backend)
    await expect(reg.acquire(ref)).rejects.toThrow()
  })
})
