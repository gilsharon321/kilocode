/**
 * AttachmentRegistry — routing state for hosted native interaction.
 *
 * `sessionHost.attach` mints an opaque, process-local attachment which becomes
 * the `workspace` selector on every native hosted request. Attachments expire,
 * are invalidated by backend restarts, and must never be persisted or leaked
 * into durable UI identity (approved D1). Expired, deleted, or unauthorized
 * attachments fail closed: the registry never returns a stale attachment, and
 * identity mismatches are rejected instead of retried blind.
 */

import type { KiloClient } from "@kilocode/sdk/v2/client"
import type { CloudRef } from "../../../webview-ui/agent-manager/cloud-types"
import { refKey } from "./identity"

/** Renew an attachment this long before its declared expiry. */
const EXPIRY_SKEW_MS = 30_000

export interface AttachmentLease {
  attachmentID: string
  expiresAt: number
}

export interface AttachmentSource {
  client(): Promise<KiloClient>
  /** Bumps on every backend replacement; any bump invalidates all leases. */
  generation(): number
  log(msg: string): void
}

interface Entry {
  lease?: AttachmentLease
  refs: number
  inflight?: Promise<AttachmentLease>
  broken?: string
}

export class AttachmentRegistry {
  private readonly entries = new Map<string, Entry>()
  private generation: number

  constructor(
    private readonly source: AttachmentSource,
    private readonly clock: () => number = Date.now,
  ) {
    this.generation = source.generation()
  }

  /**
   * Acquire (or revalidate) an attachment for one hosted target. Held refs
   * keep it alive; concurrent acquires share one in-flight attach.
   */
  async acquire(ref: CloudRef): Promise<AttachmentLease> {
    if (this.source.generation() !== this.generation) this.invalidateAll()
    const key = refKey(ref)
    const entry = this.entry(key)
    entry.refs++
    if (entry.broken) throw new HostedUnavailableError(entry.broken)
    const lease = entry.lease
    if (lease && lease.expiresAt - this.clock() > EXPIRY_SKEW_MS) return lease
    if (!entry.inflight) {
      entry.inflight = this.attach(ref)
        .then((fresh) => {
          entry.lease = fresh
          entry.broken = undefined
          return fresh
        })
        .catch((err) => {
          entry.broken = describe(err)
          entry.lease = undefined
          throw err
        })
        .finally(() => {
          entry.inflight = undefined
        })
    }
    try {
      return await entry.inflight
    } catch (err) {
      entry.refs--
      throw err
    }
  }

  /** Release one held ref; the last release detaches best-effort. */
  release(ref: CloudRef): void {
    const key = refKey(ref)
    const entry = this.entries.get(key)
    if (!entry || entry.refs === 0) return
    entry.refs--
    if (entry.refs > 0) return
    const lease = entry.lease
    entry.lease = undefined
    entry.broken = undefined
    if (lease) void this.detach(lease.attachmentID, key)
  }

  /** Forget a past failure after the catalog confirmed the row still exists. */
  reset(ref: CloudRef): void {
    const entry = this.entries.get(refKey(ref))
    if (entry && !entry.lease) entry.broken = undefined
  }

  /**
   * Drop a cached lease that a replaced backend no longer knows about.
   * Attachments live in backend memory, so a restart can leave the client
   * holding a perfectly unexpired but invalid id.
   */
  drop(ref: CloudRef): void {
    const entry = this.entries.get(refKey(ref))
    if (!entry) return
    entry.lease = undefined
    entry.inflight = undefined
    entry.broken = undefined
  }

  /** Backend restart replacement: every lease is invalid; holders must reacquire. */
  invalidateAll(): void {
    for (const entry of this.entries.values()) {
      entry.lease = undefined
      entry.broken = undefined
      entry.inflight = undefined
    }
    this.entries.clear()
    this.generation = this.source.generation()
  }

  /** Current attachment for the target, if valid-looking and present. */
  peek(ref: CloudRef): AttachmentLease | undefined {
    return this.entries.get(refKey(ref))?.lease
  }

  private entry(key: string): Entry {
    const existing = this.entries.get(key)
    if (existing) return existing
    const entry: Entry = { refs: 0 }
    this.entries.set(key, entry)
    return entry
  }

  /** Mint through the backend; no-wake by contract (durable validation only). */
  private async attach(ref: CloudRef): Promise<AttachmentLease> {
    const client = await this.source.client()
    const response = await client.sessionHost.attach(
      { providerID: ref.providerID, sessionID: ref.sessionID, organizationID: ref.organizationID },
      { throwOnError: true },
    )
    const data = response.data as { attachmentID?: string; expiresAt?: number }
    if (typeof data?.attachmentID !== "string" || data.attachmentID.length === 0) {
      throw new Error("Hosted attachment was refused")
    }
    const expiresAt = typeof data.expiresAt === "number" ? data.expiresAt : this.clock() + 60_000
    return { attachmentID: data.attachmentID, expiresAt }
  }

  private async detach(attachmentID: string, key: string): Promise<void> {
    try {
      const client = await this.source.client()
      await client.sessionHost.detach({ attachmentID }, { throwOnError: true })
    } catch (error) {
      // Releasing the local view must never surface an error; a lost detach
      // only leaves an orphaned lease in a process whose views are closing.
      this.source.log(`Cloud detach for ${key} failed: ${error}`)
    }
  }
}

/** Raised when a hosted target is unavailable (expired, deleted, unauthorized). */
export class HostedUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HostedUnavailableError"
  }
}

function describe(error: unknown): string {
  const cast = (error as { data?: { body?: { message?: string } }; message?: string }) ?? {}
  return cast.data?.body?.message ?? cast.message ?? (error instanceof Error ? error.message : String(error))
}
