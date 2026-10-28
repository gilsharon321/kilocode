import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createCloud } from "../../src/agent-manager/cloud/wiring"
import { fixture } from "./agent-cloud-fixture"

function origin(root: string, url: string) {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`)
}

describe("Cloud wiring", () => {
  it("discovers registered projects that have no live ProjectContext", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-wiring-"))
    const main = path.join(dir, "main")
    const extra = path.join(dir, "extra")
    fs.mkdirSync(main)
    fs.mkdirSync(extra)
    origin(main, "https://github.com/acme/app.git")
    origin(extra, "https://github.com/acme/other.git")
    const backend = fixture({
      workspaces: [
        { id: "w1", url: "https://github.com/acme/app.git", sessions: [] },
        { id: "w2", url: "https://github.com/acme/other.git", sessions: [] },
      ],
    })
    const posts: unknown[] = []
    const connection = {
      getClientAsync: async () => backend.client,
      onStateChange: () => () => {},
      onProfileChanged: () => () => {},
    }
    const contexts = {
      pinned: () => ({ id: "p1", root: main }),
      values: () => [][Symbol.iterator](),
    }
    const wiring = createCloud(
      connection as never,
      contexts as never,
      { list: () => [{ id: "p2", root: extra }] },
      {} as never,
      { postMessage: (message) => posts.push(message) },
    )
    wiring.visible(true)
    await wiring.service.refresh()
    const scopes = wiring.service.scopes
    // A collapsed project with no ProjectContext still gets a Cloud location.
    expect(scopes.map((scope) => scope.projectId).sort()).toEqual(["p1", "p2"])
    expect(scopes.find((scope) => scope.projectId === "p2")!.workspaces.map((ws) => ws.workspaceID)).toEqual(["w2"])
    const pushed = posts
      .filter((message) => (message as { type?: string }).type === "agentManager.cloudState")
      .at(-1) as { scopes: Array<{ projectId: string }> }
    expect(pushed.scopes.map((scope) => scope.projectId).sort()).toEqual(["p1", "p2"])
    wiring.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
