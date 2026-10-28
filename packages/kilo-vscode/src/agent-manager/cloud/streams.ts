/**
 * HostedStreams — attachment-scoped native/system event subscriptions.
 *
 * Hosted events are NOT republished on the global connection stream, so each
 * attachment gets its own `/event` and `cloudAgent.systemEvents` SSE
 * subscription through the shared client. Per the approved D3 decision,
 * unknown payloads never contribute state — they become triggers for typed
 * re-reads. Typed native payloads are handed to the same mapper the local
 * connection uses, so the hosted transcript renders through ordinary chat.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import { normalize, type SSEPayload, type WirePayload } from "../../services/cli-backend/sdk-sse-adapter"
import { refKey } from "./identity"
import type { CloudRef } from "../../../webview-ui/agent-manager/cloud-types"

interface Feed {
  attempts: number
  timer?: NodeJS.Timeout
  signal?: AbortController
}

export interface HostedStreamsSource {
  client(): Promise<KiloClient>
  /** Backend epoch; a bump stops stale reconnections. */
  generation(): number
  log(msg: string): void
}

export interface HostedStreamsHandlers {
  /**
   * Normalized typed native payload. Return true when it produced webview
   * state; false (unrecognized/control/fence frame) triggers a typed re-read.
   */
  native(normalized: SSEPayload, wire: WirePayload): boolean
  /** System-feed frame (opaque): trigger only. */
  system(): void
  /** Typed native frame the mapper could not relay (continuity/control). */
  continuity(): void
}

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 15_000
const MAX_ATTEMPTS = 8

export class HostedStreams {
  private readonly feeds = new Map<string, Feed>()
  private handlers: HostedStreamsHandlers | undefined
  private generation = -1

  constructor(private readonly source: HostedStreamsSource) {}

  /** Attach both feeds to one hosted target; replaces any previous pair. */
  attach(ref: CloudRef, attachmentID: string): void {
    const binding = `${refKey(ref)}\u0000${attachmentID}`
    if (this.binding === binding && this.feeds.size > 0) return
    this.binding = binding
    this.stop("reattach")
    this.generation = this.source.generation()
    void this.native(ref, attachmentID)
    void this.system(ref, attachmentID)
  }

  stop(reason = "stop"): void {
    for (const feed of this.feeds.values()) {
      if (feed.timer) clearTimeout(feed.timer)
      feed.timer = undefined
      feed.signal?.abort()
      feed.signal = undefined
      feed.attempts = 0
    }
    this.feeds.clear()
    this.binding = undefined
    this.source.log(`hosted streams stopped (${reason})`)
  }

  private binding: string | undefined

  setHandlers(handlers: HostedStreamsHandlers): void {
    this.handlers = handlers
  }

  private stale(): boolean {
    return this.generation !== this.source.generation()
  }

  private schedule(feed: Feed, label: string, start: () => void): void {
    if (this.stale()) return
    if (feed.attempts >= MAX_ATTEMPTS) {
      this.source.log(`hosted ${label} stream gave up; typed reads continue`)
      return
    }
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** feed.attempts)
    feed.attempts++
    feed.timer = setTimeout(() => {
      feed.timer = undefined
      start()
    }, delay)
  }

  private async native(ref: CloudRef, attachmentID: string): Promise<void> {
    const feed = this.feed("native")
    const signal = new AbortController()
    feed.signal = signal
    try {
      const client = await this.source.client()
      const events = await client.event.subscribe(
        { workspace: attachmentID },
        { signal: signal.signal, sseMaxRetryAttempts: 1 },
      )
      for await (const item of events.stream) {
        if (signal.signal.aborted) return
        feed.attempts = 0
        const payload = (item as { payload?: WirePayload }).payload ?? (item as unknown as WirePayload)
        const handled = this.handlers?.native(normalize(payload), payload)
        if (handled === false) this.handlers?.continuity()
      }
      this.schedule(feed, "native", () => void this.native(ref, attachmentID))
    } catch (error) {
      if (signal.signal.aborted) return
      this.source.log(`hosted native stream ended: ${error}`)
      this.schedule(feed, "native", () => void this.native(ref, attachmentID))
    }
  }

  private async system(ref: CloudRef, attachmentID: string): Promise<void> {
    const feed = this.feed("system")
    const signal = new AbortController()
    feed.signal = signal
    try {
      const client = await this.source.client()
      const events = await client.cloudAgent.systemEvents(
        { workspace: attachmentID },
        { signal: signal.signal, sseMaxRetryAttempts: 1 },
      )
      for await (const item of events.stream) {
        if (signal.signal.aborted) return
        feed.attempts = 0
        void item
        this.handlers?.system()
      }
      this.schedule(feed, "system", () => void this.system(ref, attachmentID))
    } catch (error) {
      if (signal.signal.aborted) return
      this.source.log(`hosted system stream ended: ${error}`)
      this.schedule(feed, "system", () => void this.system(ref, attachmentID))
    }
  }

  private feed(name: string): Feed {
    const existing = this.feeds.get(name)
    if (existing) return existing
    const feed: Feed = { attempts: 0 }
    this.feeds.set(name, feed)
    return feed
  }
}
