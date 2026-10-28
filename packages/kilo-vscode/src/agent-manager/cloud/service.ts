/**
 * CloudService — the hosted execution-location facade for Agent Manager.
 *
 * Owns the approved decisions end to end:
 * - D1 identity: the catalog is the only source that binds provider/workspace/
 *   session; conflicted native IDs are disabled, so in-extension raw-ID chat
 *   state is safe. Attachments are ephemeral routing state and never identity.
 * - D2 scopes: one discovery pass per explicit authorized scope plus the
 *   personal pass; ambient org state is never relied on.
 * - D3 events: every stream frame is an opaque trigger; typed reads are the
 *   only thing that produces UI state.
 *
 * Interaction is a fail-closed allowlist executed through an attachment
 * selector (`workspace: attachmentID`) on the same native routes local chat
 * uses. Hosted requests are intercepted before any local handler, so they
 * never touch directory routing, editor context, checkpoints, or local tools.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import { CloudCatalog, type CatalogProject } from "./catalog"
import { AttachmentRegistry, HostedUnavailableError } from "./attachments"
import { HostedStreams } from "./streams"
import { getErrorMessage, mapSSEEventToWebviewMessage, sessionToWebview } from "../../kilo-provider-utils"
import { refKey, sessionKey } from "./identity"
import type { CloudRef, CloudScopeView, CloudSessionView } from "../../../webview-ui/agent-manager/cloud-types"
import type { CloudStateMessage } from "../../../webview-ui/src/types/messages/agent-manager"

const POLL_MS = 60_000
/** Bring in turns started outside this panel (Cloud web/app) without a frame. */
const TRANSCRIPT_POLL_MS = 30_000
/** Opaque frames arrive in bursts; one typed read per window is enough. */
const REFRESH_COALESCE_MS = 10_000
const RECONCILE_COALESCE_MS = 5_000
const HISTORY_PAGE = 80

/** Host-facing plumbing shared by the cloud subsystem. */
export interface CloudServiceSource {
  /** Current client; rejects while disconnected. */
  client(): Promise<KiloClient>
  /** Backend epoch; bumps on reconnect/replace. */
  generation(): number
  /** Subscribe to backend lifecycle to reconcile the catalog immediately. */
  onGeneration(listener: () => void): () => void
  log(msg: string): void
}

interface BaseMessage {
  type?: string
  sessionID?: string
  draftID?: string
  messageID?: string
  providerID?: string
}

interface LoadMessage extends BaseMessage {
  mode?: string
  before?: string
  limit?: number
}

interface SendMessage extends BaseMessage {
  text?: string
  modelID?: string
  agent?: string
  variant?: string
  files?: Array<{ mime: string; url: string; filename?: string }>
}

export class CloudService {
  private readonly catalog: CloudCatalog
  private readonly attachments: AttachmentRegistry
  private readonly streams: HostedStreams
  private readonly holding = new Map<string, CloudRef>()
  /** The hosted target currently shown in chat; cleared when a local target takes over. */
  private focused: CloudRef | undefined
  private timer: NodeJS.Timeout | undefined
  private liveTimer: NodeJS.Timeout | undefined
  private refreshQueued: NodeJS.Timeout | undefined
  private reconcileQueued: NodeJS.Timeout | undefined
  private lastError: { message: string; at: number } | undefined
  private lastPush: string | undefined
  private lastReconcile = new Map<string, string>()
  private streamSeen = new Map<string, string>()
  private disposed = false
  private started = false

  constructor(
    private readonly backend: CloudServiceSource,
    projects: () => Promise<CatalogProject[]>,
    private readonly post: (message: unknown) => void,
  ) {
    this.catalog = new CloudCatalog({
      client: () => backend.client(),
      projects,
      changed: () => this.push(),
      log: (msg) => console.log(`[Kilo New] Cloud: ${msg}`),
    })
    this.attachments = new AttachmentRegistry({
      client: () => backend.client(),
      generation: () => backend.generation(),
      log: (msg) => console.log(`[Kilo New] Cloud: ${msg}`),
    })
    this.streams = new HostedStreams({
      client: () => backend.client(),
      generation: () => backend.generation(),
      log: (msg) => console.log(`[Kilo New] Cloud: ${msg}`),
    })
    this.streams.setHandlers({
      native: (normalized) => this.onNative(normalized),
      // Opaque triggers can arrive in bursts; coalesce re-reads instead of one
      // request per frame.
      system: () => {
        this.scheduleRefresh()
        this.scheduleReconcile()
      },
      continuity: () => this.scheduleReconcile(),
    })
    backend.onGeneration(() => {
      if (this.disposed) return
      // Backend restart: leases are process-local and invalid. Drop them, so
      // the next interaction mints fresh ones, and reconcile the catalog.
      this.attachments.invalidateAll()
      void this.refresh()
    })
  }

  /** Begin lifecycle: reconcile now, on backend change, and on a bounded poll. */
  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    void this.refresh()
    // Show the loading state right away; the first reconcile pushes again.
    this.push()
    // Reattach live streams for views that stayed held while hidden.
    for (const ref of this.holding.values()) {
      const lease = this.attachments.peek(ref)
      if (lease) this.streams.attach(ref, lease.attachmentID)
    }
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
    this.liveTimer = setInterval(() => {
      if (this.focused) void this.reconcile(this.focused)
    }, TRANSCRIPT_POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.liveTimer) clearInterval(this.liveTimer)
    this.timer = undefined
    this.liveTimer = undefined
    // Visibility can resume discovery; detach() is the terminal stop.
    this.started = false
    this.streams.stop("hidden")
  }

  /** Panel closed: stop feeds and release views; remote work keeps running. */
  detach(): void {
    this.stop()
    if (this.refreshQueued) clearTimeout(this.refreshQueued)
    if (this.reconcileQueued) clearTimeout(this.reconcileQueued)
    this.refreshQueued = undefined
    this.reconcileQueued = undefined
    // Detach-only: closing the panel must never abort cloud work.
    for (const ref of this.holding.values()) this.attachments.release(ref)
    this.holding.clear()
    this.focused = undefined
    this.streamSeen.clear()
    this.lastReconcile.clear()
    this.started = false
  }

  dispose(): void {
    this.disposed = true
    this.detach()
  }

  /** Kick a catalog reconcile (initial, profile change, reconnect, manual). */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return this.catalog.refresh().then(
      () => this.push(),
      () => {},
    )
  }

  /** Coalesce opaque event frames into one catalog read. */
  private scheduleRefresh(): void {
    if (this.disposed || this.refreshQueued) return
    this.refreshQueued = setTimeout(() => {
      this.refreshQueued = undefined
      void this.refresh()
    }, REFRESH_COALESCE_MS)
  }

  /** Coalesce continuity frames into one typed re-read per held view. */
  private scheduleReconcile(): void {
    if (this.disposed || this.reconcileQueued) return
    this.reconcileQueued = setTimeout(() => {
      this.reconcileQueued = undefined
      // Only the visible view is worth re-reading; older holds are released.
      const targets = this.focused ? [this.focused] : [...this.holding.values()]
      for (const ref of targets) void this.reconcile(ref)
    }, RECONCILE_COALESCE_MS)
  }

  /** Surface one banner per distinct failure; background reconciles stay quiet. */
  private report(message: string): void {
    const now = Date.now()
    if (this.lastError?.message === message && now - this.lastError.at < 15_000) return
    this.lastError = { message, at: now }
    this.post({ type: "error", message })
  }

  /** Latest serializable webview state. */
  snapshot(): CloudStateMessage {
    const snap = this.catalog.snapshot()
    return { type: "agentManager.cloudState", scopes: snap.scopes }
  }

  push(): void {
    const snapshot = this.snapshot()
    // Polls and stream triggers often produce identical catalogs; re-pushing
    // them re-creates webview rows and makes the Cloud list blink.
    const json = JSON.stringify(snapshot)
    if (json === this.lastPush) return
    this.lastPush = json
    this.post(snapshot)
  }

  get scopes(): CloudScopeView[] {
    return this.catalog.snapshot().scopes
  }

  /** Catalog row for a native session ID; conflicted rows never resolve. */
  find(providerID: string | undefined, sessionID: string): CloudRef | undefined {
    for (const scope of this.scopes) {
      for (const workspace of scope.workspaces) {
        for (const session of workspace.sessions) {
          if (session.sessionID !== sessionID) continue
          if (providerID && session.providerID !== providerID) continue
          if (session.conflict) return undefined
          return session
        }
      }
    }
    // Catalog polls can be briefly empty while a view is already open; the
    // held focus still carries the full compound identity.
    const focus = this.focused
    if (focus && focus.sessionID === sessionID && (!providerID || focus.providerID === providerID)) return focus
    return undefined
  }

  /** Catalog presence for the exact compound binding (D1 fail-closed). */
  binding(ref: CloudRef): CloudSessionView | undefined {
    for (const scope of this.scopes) {
      if (scope.projectId !== ref.projectId) continue
      for (const workspace of scope.workspaces) {
        if (workspace.providerID !== ref.providerID || workspace.workspaceID !== ref.workspaceID) continue
        for (const row of workspace.sessions) {
          if (row.sessionID !== ref.sessionID) continue
          if (row.conflict) return undefined
          return row
        }
      }
    }
    return undefined
  }

  isHosted(sessionID: string): boolean {
    return this.find(undefined, sessionID) !== undefined
  }

  /** Whether a message targets a hosted session and must not run locally. */
  isHostedMessage(message: unknown): boolean {
    const sessionID = (message as BaseMessage | undefined)?.sessionID
    if (!sessionID) return false
    return this.isHosted(sessionID)
  }

  /**
   * Intercept a webview message for hosted handling. Returns true when the
   * message was handled by cloud behavior, so local handlers must not run.
   * Unsupported operations targeting a hosted session are consumed with an
   * explicit error rather than falling through to local behavior.
   */
  async intercept(message: unknown): Promise<boolean> {
    if (this.disposed) return false
    const msg = (message ?? {}) as BaseMessage
    if (msg.type === "requestSessionModelUsage" && msg.sessionID && this.isHosted(msg.sessionID)) {
      this.post({
        type: "sessionModelUsageLoaded",
        sessionID: msg.sessionID,
        requestID: (msg as { requestID: string }).requestID,
      })
      return true
    }
    const handler = msg.type ? this.routes()[msg.type] : undefined
    if (handler && (await handler(msg))) return true
    if (!this.isHostedMessage(msg)) return false
    // Chat views probe several local-only endpoints when a session opens. None
    // apply to a hosted session, and surfacing one banner per probe is hostile,
    // so consume them silently and keep local handlers from running.
    console.log(`[Kilo New] Cloud: ignoring ${msg.type} for hosted session ${msg.sessionID}`)
    return true
  }

  /**
   * The explicit hosted allowlist. Every supported interaction resolves its
   * target through the catalog and returns false for sessions it does not
   * host, so local sessions keep their ordinary handlers.
   */
  private routes(): Record<string, (msg: BaseMessage) => boolean | Promise<boolean>> {
    return {
      "agentManager.refreshCloud": () => {
        // Replay what we already know so a freshly mounted webview renders the
        // location immediately, then reconcile in the background.
        this.push()
        void this.refresh()
        return true
      },
      "agentManager.activateSelection": (msg) => {
        // Any non-cloud selection hands the chat back to local targets.
        if ((msg as { target?: { kind?: string } }).target?.kind !== "cloud") this.focused = undefined
        return false
      },
      requestGitChangesContext: (msg) => this.gitChanges(msg),
      requestFileSearch: (msg) => this.fileSearch(msg),
      // Transcript actions resolve paths and diffs against the local checkout.
      openFile: (msg) => this.hostedContext(msg) && this.refuse(msg),
      openChanges: (msg) => this.hostedContext(msg) && this.refuse(msg),
      loadMessages: (msg) => {
        // The request carries only the native session ID; attach needs the full
        // compound identity (provider/workspace/org) from the catalog row.
        const view = this.hostedGuard(msg)
        const load = msg as LoadMessage
        return !!view && this.load(view, load.mode, load.before, load.limit)
      },
      sendMessage: (msg) => !!this.hostedGuard(msg) && this.onSend(msg),
      sendCommand: (msg) => !!this.hostedGuard(msg) && this.onCommand(msg),
      abort: (msg) => !!this.hostedGuard(msg) && this.onAbort(msg),
      permissionResponse: (msg) => !!this.hostedGuard(msg) && this.onPermission(msg),
      questionReply: (msg) => !!this.hostedGuard(msg) && this.onQuestionReply(msg),
      questionReject: (msg) => !!this.hostedGuard(msg) && this.onQuestionReject(msg),
    }
  }

  /**
   * Typed native payload from an attachment stream. Returns true when the
   * ordinary mapper produced webview state for a hosted session; false means
   * an unrecognized/control frame, which becomes a re-read trigger (D3).
   */
  private onNative(normalized: unknown): boolean {
    const event = normalized as {
      type?: string
      properties?: { sessionID?: string }
      data?: { sessionID?: string; info?: { sessionID?: string } }
    }
    const sessionID =
      event.type === "sync" ? (event.data?.sessionID ?? event.data?.info?.sessionID) : event.properties?.sessionID
    if (!sessionID || !this.isHosted(sessionID)) return false
    const mapped = mapSSEEventToWebviewMessage(event as never, sessionID)
    if (!mapped) return false
    const type = (mapped as { type?: string }).type
    if (type === "sessionStatus" || type === "sessionCreated") {
      const key = `${sessionID}:${type}`
      const signature = JSON.stringify(mapped)
      // Replayed snapshots from a reconnecting feed must not restart animations.
      if (this.streamSeen.get(key) === signature) return true
      this.streamSeen.set(key, signature)
    }
    this.post(mapped)
    return true
  }

  /** Whether a request belongs to a hosted chat: its session, or the focused one when none is named. */
  private hostedContext(msg: BaseMessage): boolean {
    return msg.sessionID ? this.isHosted(msg.sessionID) : this.focused !== undefined
  }

  /** Consume a local-only request for a hosted chat; it is dropped, never run locally. */
  private refuse(msg: BaseMessage): true {
    console.log(`[Kilo New] Cloud: ${msg.type} is not available for a hosted session`)
    return true
  }

  /** Composer mentions search the local workspace; a hosted chat answers with no results. */
  private fileSearch(msg: BaseMessage & { requestId?: string }): boolean {
    if (!this.hostedContext(msg)) return false
    this.post({ type: "fileSearchResult", paths: [], items: [], dir: "", requestId: msg.requestId ?? "" })
    return true
  }

  /**
   * `@git-changes` resolves against a local checkout. For a hosted session it
   * would silently attach unrelated local diffs to a Cloud prompt, so it is
   * refused explicitly. The request may omit the session ID, so the focused
   * hosted chat counts too.
   */
  private gitChanges(msg: BaseMessage & { requestId?: string }): boolean {
    if (!this.hostedContext(msg)) return false
    this.post({
      type: "gitChangesContextError",
      requestId: msg.requestId ?? "",
      error: "Git changes are not available for Cloud sessions.",
    })
    return true
  }

  /** Guard for intercept paths that resolve sessions by native ID. */
  private hostedGuard(msg: BaseMessage): CloudRef | undefined {
    if (!msg.sessionID) return undefined
    // `providerID` on chat messages is the *model* provider (e.g. "kilo"), not
    // the session host provider ("kilo-cloud"). Resolve by native session ID;
    // conflicted IDs never reach this point.
    return this.find(undefined, msg.sessionID)
  }

  // ── Wires: durable history and interaction through typed native reads ──

  private async load(view: CloudRef, mode?: string, before?: string, limit = HISTORY_PAGE): Promise<boolean> {
    const ref = view
    const result = await this.run(ref, "history", async (client, workspace) => {
      const [session, page] = await Promise.all([
        client.session.get({ sessionID: ref.sessionID, workspace }, { throwOnError: true }),
        client.session.messages({ sessionID: ref.sessionID, workspace, limit, before }, { throwOnError: true }),
      ])
      // The session row is stable while only history is re-read; re-posting it
      // on every reconcile churns the webview store (session header flicker).
      const next = mode === "focus" ? "reconcile" : (mode ?? "replace")
      if (session.data && next !== "reconcile") {
        this.post({ type: "sessionCreated", session: sessionToWebview(session.data as never) })
      }
      // Durable history is an array of `{ info, parts }`; the webview renders a
      // flattened message with a top-level `createdAt`, exactly like local chat.
      const items = Array.isArray(page.data) ? page.data : []
      const messages = items.map((item) => {
        const info = (item as { info: Record<string, unknown> }).info
        return {
          ...info,
          parts: (item as { parts: unknown[] }).parts,
          createdAt: new Date(Number((info.time as { created?: number })?.created ?? 0)).toISOString(),
        }
      })
      const cursor = page.response?.headers?.get("X-Next-Cursor") ?? undefined
      // A periodic reconcile over an unchanged transcript must not re-render
      // the chat; only post when the authoritative content actually changed.
      const signature = JSON.stringify(messages)
      if (next === "reconcile" && this.lastReconcile.get(ref.sessionID) === signature) return
      this.lastReconcile.set(ref.sessionID, signature)
      const since = next === "reconcile" ? Date.now() : undefined
      this.post({
        type: "messagesLoaded",
        sessionID: ref.sessionID,
        messages,
        mode: next,
        cursor,
        hasMore: Boolean(cursor),
        since,
      })
    })
    if (!result.ok) {
      // A background reconcile keeps the transcript already on screen; only a
      // user-initiated open should clear loading and raise a banner.
      if (mode !== "reconcile" && mode !== "focus") {
        this.post({ type: "messagesLoaded", sessionID: ref.sessionID, messages: [], mode: "replace" })
        this.report(`Could not load this Cloud session: ${result.error}`)
      }
      return false
    }
    this.lastError = undefined
    return true
  }

  private async onSend(msg: unknown): Promise<boolean> {
    const m = msg as SendMessage
    const view = this.hostedGuard(m)
    if (!view) return false
    // Cloud's public prompt body is strict: text parts only, kilo models only,
    // and no variant/noReply/format/tools fields. Anything else is rejected
    // before the turn is admitted, so the workspace never wakes.
    if (m.files?.length) {
      this.post({
        type: "sendMessageFailed",
        sessionID: m.sessionID,
        error: "File attachments are not supported for Cloud sessions",
        text: m.text,
        draftID: m.draftID,
        messageID: m.messageID,
      })
      return true
    }
    const text = m.text ?? ""
    if (!text) return false
    const parts = [{ type: "text" as const, text }]
    const model = m.providerID === "kilo" && m.modelID ? { providerID: "kilo" as const, modelID: m.modelID } : undefined
    const ref = view
    const send = () =>
      this.run(ref, "prompt", async (client, workspace) => {
        // No editorContext, no checkpoints, no prepareTools: the hosted path is
        // prompt-only by capability contract.
        await client.session.promptAsync(
          {
            sessionID: ref.sessionID,
            workspace,
            parts,
            model,
            agent: m.agent,
            messageID: m.messageID,
          },
          { throwOnError: true },
        )
      })
    let result = await send()
    // Cloud transport can blip while a sleeping workspace wakes. The message ID
    // makes a retry idempotent, so resend once instead of losing the prompt.
    if (!result.ok && /unreachable|unavailable|fetch failed|timed out|timeout/i.test(result.error)) {
      await new Promise((resolve) => setTimeout(resolve, 750))
      result = await send()
    }
    this.post({
      type: result.ok ? "sessionStatus" : "sendMessageFailed",
      sessionID: m.sessionID,
      status: result.ok ? "busy" : undefined,
      error: result.ok ? undefined : result.error,
      text: result.ok ? undefined : m.text,
      draftID: m.draftID,
      messageID: m.messageID,
    })
    // A prompt wakes a sleeping workspace; re-read status instead of waiting
    // for the slow poll so the location stops saying "sleeping".
    if (result.ok) {
      this.scheduleRefresh()
      this.scheduleReconcile()
    }
    return true
  }

  private async onCommand(msg: unknown): Promise<boolean> {
    const m = msg as BaseMessage & { command?: string; arguments?: string }
    const view = this.hostedGuard(m)
    if (!view) return false
    const command = m.command ?? ""
    const text = command.startsWith("/") ? command : `/${command}${m.arguments ? ` ${m.arguments}` : ""}`
    const ref = view
    const parts = [{ type: "text" as const, text } as never]
    const result = await this.run(ref, "command", async (client, workspace) => {
      await client.session.promptAsync(
        { sessionID: ref.sessionID, workspace, parts, messageID: m.messageID },
        { throwOnError: true },
      )
    })
    this.post({
      type: result.ok ? "sessionStatus" : "sendMessageFailed",
      sessionID: m.sessionID,
      status: result.ok ? "busy" : undefined,
      error: result.ok ? undefined : result.error,
      text: result.ok ? undefined : text,
      draftID: m.draftID,
      messageID: m.messageID,
    })
    return true
  }

  private async onAbort(msg: unknown): Promise<boolean> {
    const m = msg as BaseMessage & { scope?: "session" | "tree" }
    const view = this.hostedGuard(m)
    if (!view) return false
    const ref = view
    // Stop aborts only the selected native session's current turn.
    const result = await this.run(ref, "abort", async (client, workspace) => {
      await client.session.abort({ sessionID: ref.sessionID, workspace, scope: "session" }, { throwOnError: true })
    })
    if (result.ok) this.post({ type: "sessionStatus", sessionID: m.sessionID, status: "idle" })
    return true
  }

  private async onPermission(msg: unknown): Promise<boolean> {
    const m = msg as BaseMessage & { permissionId?: string; response?: "once" | "always" | "reject" }
    const id = m.permissionId
    if (!id || !m.sessionID) return false
    const view = this.hostedGuard(m)
    if (!view) return false
    const ref = view
    const result = await this.run(ref, "permission", async (client, workspace) => {
      await client.permission.reply({ requestID: id, workspace, reply: m.response ?? "reject" }, { throwOnError: true })
    })
    this.post(
      result.ok ? { type: "permissionResolved", permissionID: id } : { type: "permissionError", permissionID: id },
    )
    return true
  }

  private async onQuestionReply(msg: unknown): Promise<boolean> {
    const m = msg as BaseMessage & { requestID?: string; answers?: string[][] }
    const id = m.requestID
    if (!id) return false
    const view = this.hostedGuard(m)
    if (!view) return false
    const ref = view
    const result = await this.run(ref, "question", async (client, workspace) => {
      await client.question.reply({ requestID: id, workspace, answers: m.answers ?? [] }, { throwOnError: true })
    })
    if (result.ok) this.post({ type: "questionResolved", requestID: id })
    return true
  }

  private async onQuestionReject(msg: unknown): Promise<boolean> {
    const m = msg as BaseMessage & { requestID?: string }
    const id = m.requestID
    if (!id) return false
    const view = this.hostedGuard(m)
    if (!view) return false
    const ref = view
    await this.run(ref, "question", async (client, workspace) => {
      await client.question.reject({ requestID: id, workspace }, { throwOnError: true })
    })
    this.post({ type: "questionResolved", requestID: id })
    return true
  }

  /** Execute the allowed subset; anything else fails closed with a reason. */
  private async run(
    ref: CloudRef,
    kind: string,
    exec: (client: KiloClient, workspace: string) => Promise<unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const lease = await this.attachments.acquire(ref)
        this.holding.set(refKey(ref), ref)
        this.streams.attach(ref, lease.attachmentID)
        const client = await this.backend.client()
        await exec(client, lease.attachmentID)
        return { ok: true }
      } catch (error) {
        // A replaced backend forgets every attachment. The cached lease still
        // looks unexpired, so retry once with a freshly minted attachment.
        if (attempt === 0 && attachmentGone(error)) {
          this.attachments.drop(ref)
          continue
        }
        const message = error instanceof HostedUnavailableError ? error.message : getErrorMessage(error)
        console.warn(`[Kilo New] Cloud: ${kind} refused for ${ref.sessionID}: ${message}`)
        return { ok: false, error: message }
      }
    }
  }

  /** View opened: hold the target and keep its streams alive. */
  hold(ref: CloudRef): void {
    const key = refKey(ref)
    // Only one hosted view is visible at a time. Drop older holds so switching
    // sessions never leaves stale streams or attachments behind.
    for (const [heldKey, held] of this.holding) {
      if (heldKey === key) continue
      this.holding.delete(heldKey)
      this.attachments.release(held)
    }
    this.focused = ref
    this.holding.set(key, ref)
    const lease = this.attachments.peek(ref)
    if (lease) this.streams.attach(ref, lease.attachmentID)
  }

  release(ref: CloudRef): void {
    this.holding.delete(refKey(ref))
    this.attachments.release(ref)
    this.streams.stop("release")
  }

  /** Key used by the webview to identify a hosted session compoundly. */
  keyOf(ref: CloudRef): string {
    return sessionKey(ref.providerID, ref.workspaceID, ref.sessionID)
  }

  private async reconcile(ref: CloudRef): Promise<void> {
    const row = this.binding(ref)
    if (row) await this.load(row, "reconcile")
  }
}

/** Attachment ids are backend-local: a restart turns every cached id into an unknown id. */
function attachmentGone(error: unknown): boolean {
  const body = (error as { data?: { body?: { error?: string; code?: string } } })?.data?.body
  if (body?.error !== "KILO_SESSION_ATTACHMENT") return false
  return body.code === "unknown" || body.code === "expired" || body.code === "disposed"
}
