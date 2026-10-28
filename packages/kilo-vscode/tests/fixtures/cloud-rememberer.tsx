import assert from "node:assert/strict"

const { createRoot } = await import("solid-js")
const { createTargetRememberer } = await import("../../webview-ui/agent-manager/project/selection")

async function run(hosted: boolean) {
  const posted: unknown[] = []
  const dispose = createRoot((dispose) => {
    createTargetRememberer({
      pid: () => "p1",
      applied: () => "p1",
      selection: () => "local",
      owns: () => true,
      // While a Cloud chat is open the current session is the hosted native ID.
      sessionId: () => "ses-hosted",
      hosted: () => hosted,
      post: (message) => posted.push(message),
    })
    return dispose
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  dispose()
  return posted
}

// Control: with no hosted chat the effect really runs and remembers the session.
assert.deepEqual(await run(false), [
  {
    type: "agentManager.rememberTarget",
    projectId: "p1",
    target: { projectId: "p1", kind: "session", sessionId: "ses-hosted" },
  },
])

// Hosted: nothing is persisted, so the stale local selection survives and the
// hosted ID can never be restored into Local tabs.
assert.deepEqual(await run(true), [])
