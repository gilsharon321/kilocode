/**
 * Fixture backend for Cloud tests: implements only the SDK surface the Cloud
 * subsystem calls, backed by in-memory workspaces. Calls are recorded so tests
 * can assert what reached the (fake) wire.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"

export interface FixtureSession {
  id: string
  title?: string
  updated?: number
}

export interface FixtureWorkspace {
  id: string
  url?: string
  name?: string
  branch?: string
  org?: string
  deletion?: "active" | "deleting" | "deleted"
  sessions: FixtureSession[]
}

export interface Call {
  name: string
  args: Record<string, unknown>
}

/** An SSE-like async iterable that yields pushed frames until aborted. */
function stream(sinks: Array<(frame: unknown) => void>, signal?: AbortSignal): AsyncIterable<unknown> {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  sinks.push((frame) => {
    queue.push(frame)
    wake?.()
  })
  return {
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve
            signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          continue
        }
        yield queue.shift()
      }
    },
  }
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(`${status} ${message}`), { data: { body: { message } } })
}

function staleAttachment(): never {
  throw Object.assign(new Error("404 Session attachment was not found"), {
    data: { body: { error: "KILO_SESSION_ATTACHMENT", code: "unknown", message: "Session attachment was not found" } },
  })
}

export function fixture(opts: {
  workspaces: FixtureWorkspace[]
  orgs?: string[]
  /** Page size to force pagination. */
  page?: number
  /** Scope keys (org id or "personal") that reject as unauthorized. */
  denied?: string[]
  /** Repeat the first cursor forever (stale-server guard). */
  loop?: boolean
  attachExpiresIn?: number
  /** Durable history returned by `session.messages` for every session. */
  messages?: Array<{ info: Record<string, unknown>; parts: unknown[] }>
  /** Make the durable transcript read fail as if Cloud were unreachable. */
  failMessages?: boolean
  /** Reject native reads whose attachment the current (simulated) backend did not mint. */
  validateAttachments?: boolean
  /** Fail every workspace listing as if Cloud were unreachable. */
  failWorkspaces?: boolean
}) {
  const calls: Call[] = []
  /** Frames pushed by tests into hosted native / system streams. */
  const feeds = { native: [] as Array<(frame: unknown) => void>, system: [] as Array<(frame: unknown) => void> }
  const page = opts.page ?? 100
  const scope = (org?: unknown) => (typeof org === "string" ? org : "personal")
  const record = (name: string, args: Record<string, unknown>) => calls.push({ name, args })
  let attachments = 0
  const live = new Map<string, { providerID: string; sessionID: string }>()

  const client = {
    kilo: {
      profile: async () => ({
        data: { profile: { organizations: (opts.orgs ?? []).map((id) => ({ id, name: id, role: "member" })) } },
      }),
    },
    sessionHost: {
      listWorkspaces: async (args: Record<string, unknown>) => {
        record("listWorkspaces", args)
        if (opts.failWorkspaces) fail(503, "Kilo Cloud is unreachable")
        const key = scope(args.organizationID)
        if (opts.denied?.includes(key)) fail(401, "unauthorized")
        const all = opts.workspaces.filter((ws) => (ws.org ?? "personal") === key)
        const start = args.cursor ? Number(args.cursor) : 0
        const items = all.slice(start, start + page).map((ws) => ({
          id: { providerID: "cloud", workspaceID: ws.id },
          name: ws.name,
          repository: { url: ws.url, branch: ws.branch },
          deletionState: ws.deletion ?? "active",
          sessions: [],
        }))
        const next = start + page < all.length ? String(start + page) : undefined
        return { data: { items, cursor: opts.loop ? "0" : next } }
      },
      listWorkspaceSessions: async (args: Record<string, unknown>) => {
        record("listWorkspaceSessions", args)
        const ws = opts.workspaces.find((item) => item.id === args.workspaceID)
        const start = args.cursor ? Number(args.cursor) : 0
        const all = ws?.sessions ?? []
        const items = all.slice(start, start + page).map((s) => ({
          id: { providerID: "cloud", sessionID: s.id },
          title: s.title,
          created: 1,
          updated: s.updated ?? 2,
        }))
        return { data: { items, cursor: start + page < all.length ? String(start + page) : undefined } }
      },
      getWorkspaceStatus: async (args: Record<string, unknown>) => {
        record("getWorkspaceStatus", args)
        return {
          data: {
            id: { providerID: "cloud", workspaceID: args.workspaceID },
            deletionState: "active",
            compute: { status: "sleeping" },
            activity: { activeSessionCount: 0, hasActiveTurn: false },
            wakeOnInput: { available: true, blockedReason: null },
            billing: { rate: { estimatedHourlyMicrodollars: 250_000 } },
          },
        }
      },
      attach: async (args: Record<string, unknown>) => {
        record("attach", args)
        const id = `att-${++attachments}`
        live.set(id, { providerID: String(args.providerID), sessionID: String(args.sessionID) })
        return { data: { attachmentID: id, expiresAt: Date.now() + (opts.attachExpiresIn ?? 600_000) } }
      },
      detach: async (args: Record<string, unknown>) => {
        record("detach", args)
        live.delete(String(args.attachmentID))
        return { data: undefined }
      },
    },
    session: {
      get: async (args: Record<string, unknown>) => {
        record("session.get", args)
        if (opts.validateAttachments && !live.has(String(args.workspace))) staleAttachment()
        return { data: { id: args.sessionID, time: { created: 1, updated: 2 } } }
      },
      messages: async (args: Record<string, unknown>) => {
        record("session.messages", args)
        if (opts.validateAttachments && !live.has(String(args.workspace))) staleAttachment()
        if (opts.failMessages) fail(503, "Kilo Cloud is unreachable")
        return { data: opts.messages ?? [], response: { headers: new Headers() } }
      },
      promptAsync: async (args: Record<string, unknown>) => {
        record("session.promptAsync", args)
        return { data: undefined }
      },
      abort: async (args: Record<string, unknown>) => {
        record("session.abort", args)
        return { data: undefined }
      },
    },
    permission: {
      reply: async (args: Record<string, unknown>) => {
        record("permission.reply", args)
        return { data: undefined }
      },
    },
    question: {
      reply: async (args: Record<string, unknown>) => {
        record("question.reply", args)
        return { data: undefined }
      },
      reject: async (args: Record<string, unknown>) => {
        record("question.reject", args)
        return { data: undefined }
      },
    },
    event: {
      subscribe: async (args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        record("event.subscribe", args)
        return { stream: stream(feeds.native, options?.signal) }
      },
    },
    cloudAgent: {
      systemEvents: async (args: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        record("cloudAgent.systemEvents", args)
        return { stream: stream(feeds.system, options?.signal) }
      },
    },
  } as unknown as KiloClient

  return { client, calls, live, feeds }
}
