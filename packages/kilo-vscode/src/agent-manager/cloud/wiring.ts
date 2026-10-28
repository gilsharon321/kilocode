/**
 * Provider wiring for the Cloud execution location, extracted so
 * AgentManagerProvider stays within its size cap and this stays vscode-free.
 */

import type { KiloConnectionService } from "../../services/cli-backend"
import type { ProjectContexts } from "../project/contexts"
import type { ProjectRegistry } from "../project/registry"
import { CloudService } from "./service"
import { originUrl } from "./origin"

export interface CloudWiring {
  service: CloudService
  /** Panel visibility: discovery polls only while the panel can show it. */
  visible(visible: boolean): void
  /** Refresh only when the registered project set changed. */
  sync(): void
  dispose(): void
}

/**
 * Build the Cloud service on the shared backend connection and project
 * registry, and register it with the project message handlers so Cloud
 * selections validate against the catalog.
 */
export function createCloud(
  connection: KiloConnectionService,
  contexts: ProjectContexts,
  registry: Pick<ProjectRegistry, "list">,
  projects: { cloud?: Pick<CloudService, "binding" | "hold"> },
  provider: { postMessage(message: unknown): void },
): CloudWiring {
  const opts = {
    connection,
    contexts,
    post: (message: unknown) => provider.postMessage(message),
    log: (...args: unknown[]) => console.log("[Kilo New] Cloud:", ...args),
  }
  // Discovery covers every registered project, including collapsed ones that
  // have no ProjectContext yet.
  const roots = () => {
    const seen = new Map<string, string>()
    const pinned = opts.contexts.pinned()
    if (pinned) seen.set(pinned.id, pinned.root)
    for (const stored of registry.list()) seen.set(stored.id, stored.root)
    return [...seen].map(([id, root]) => ({ id, repositoryUrl: originUrl(root) }))
  }
  const signature = () =>
    roots()
      .map((project) => project.id)
      .sort()
      .join("\u0000")
  let known = ""
  let shown = false
  const sync = () => {
    const next = signature()
    if (next === known || !shown) return
    known = next
    void service.refresh()
  }
  // Epoch bumps on every backend state change; attachments and streams are
  // process-local and are invalidated by it.
  const epoch = { n: 0 }
  const service = new CloudService(
    {
      client: () => opts.connection.getClientAsync(),
      generation: () => epoch.n,
      onGeneration: (listener) =>
        opts.connection.onStateChange(() => {
          epoch.n++
          listener()
        }),
      log: (...args) => opts.log("Cloud:", ...args),
    },
    async () => roots(),
    opts.post,
  )
  // Sign-in/out and organization changes invalidate Cloud access immediately.
  const unsub = opts.connection.onProfileChanged(() => void service.refresh())
  projects.cloud = service
  return {
    service,
    sync,
    visible: (visible) => {
      shown = visible
      if (visible) {
        service.start()
        sync()
        service.push()
      } else service.stop()
    },
    dispose: () => {
      unsub()
      service.dispose()
    },
  }
}
