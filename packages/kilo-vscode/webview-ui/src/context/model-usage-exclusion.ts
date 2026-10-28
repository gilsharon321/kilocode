export function createModelUsageExclusion() {
  const excluded = new Set<string>()
  const pending = new Set<string>()
  return {
    set(id: string, enabled: boolean, requestID?: string) {
      if (!enabled) return void excluded.delete(id)
      excluded.add(id)
      if (requestID) pending.add(requestID)
    },
    has(id: string) {
      return excluded.has(id)
    },
    discard(requestID: string) {
      return pending.delete(requestID)
    },
  }
}
