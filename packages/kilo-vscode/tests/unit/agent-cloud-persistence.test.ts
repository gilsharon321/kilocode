import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { WorktreeStateManager } from "../../src/agent-manager/WorktreeStateManager"
import { fixture } from "../fixtures/run"

const cloud = { projectId: "p1", kind: "cloud", providerID: "cloud", workspaceID: "w1", sessionId: "ses-1" } as const

describe("hosted targets in persisted state", () => {
  let root: string
  let state: WorktreeStateManager

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-persist-"))
    fs.mkdirSync(path.join(root, ".kilo"), { recursive: true })
    state = new WorktreeStateManager(root, () => {})
  })

  afterEach(async () => {
    await state.flush()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("refuses to store a Cloud target and keeps the last real selection", async () => {
    state.setActiveTarget({ projectId: "p1", kind: "local" })
    state.setActiveTarget(cloud)
    expect(state.getActiveTarget()).toEqual({ projectId: "p1", kind: "local" })
    await state.flush()
    const saved = fs.readFileSync(path.join(root, ".kilo", "agent-manager.json"), "utf8")
    expect(saved).not.toContain("cloud")
    expect(saved).not.toContain("ses-1")
  })

  it("drops a Cloud target found in an existing state file on load", async () => {
    fs.writeFileSync(
      path.join(root, ".kilo", "agent-manager.json"),
      JSON.stringify({ worktrees: {}, sessions: {}, activeTarget: cloud }),
    )
    const loaded = new WorktreeStateManager(root, () => {})
    await loaded.load()
    expect(loaded.getActiveTarget()).toBeUndefined()
  })
})

it(
  "does not remember a hosted session ID or a stale local selection while a hosted chat is shown",
  () => fixture("cloud-rememberer"),
  30_000,
)
