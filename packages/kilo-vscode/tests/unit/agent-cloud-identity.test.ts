import { describe, expect, it } from "bun:test"
import {
  canonicalRepositoryUrl,
  repositoriesMatch,
  sessionKey,
  workspaceKey,
} from "../../src/agent-manager/cloud/identity"

describe("Cloud compound identity", () => {
  it("keeps keys unambiguous for IDs containing delimiters", () => {
    // Naive colon/slash joins would collapse these to the same string.
    expect(sessionKey("a:b", "c", "d")).not.toBe(sessionKey("a", "b:c", "d"))
    expect(sessionKey("a", "b", "c/d")).not.toBe(sessionKey("a", "b/c", "d"))
    expect(workspaceKey("p", "w")).not.toBe(sessionKey("p", "w", ""))
  })

  it("separates identical session IDs in different providers and workspaces", () => {
    expect(sessionKey("cloud", "w1", "ses_1")).not.toBe(sessionKey("cloud", "w2", "ses_1"))
    expect(sessionKey("cloud", "w1", "ses_1")).not.toBe(sessionKey("other", "w1", "ses_1"))
  })
})

describe("canonical repository identity", () => {
  it("treats ssh, scp-like and https forms of one repository as equal", () => {
    const forms = [
      "https://github.com/Kilo-Org/kilocode.git",
      "https://github.com/kilo-org/kilocode",
      "git@github.com:Kilo-Org/kilocode.git",
      "ssh://git@github.com/Kilo-Org/kilocode.git",
      "https://user:token@github.com:443/Kilo-Org/kilocode.git",
    ]
    const canon = forms.map(canonicalRepositoryUrl)
    expect(new Set(canon).size).toBe(1)
    expect(canon[0]).toBe("github.com/kilo-org/kilocode")
  })

  it("does not match similarly named but unrelated repositories", () => {
    expect(repositoriesMatch("https://github.com/acme/app", "https://github.com/acme/app-2")).toBe(false)
    expect(repositoriesMatch("https://github.com/acme/app", "https://github.com/other/app")).toBe(false)
    expect(repositoriesMatch("https://github.com/acme/app", "https://gitlab.com/acme/app")).toBe(false)
  })

  it("never matches a missing or unparsable URL", () => {
    expect(repositoriesMatch(undefined, undefined)).toBe(false)
    expect(repositoriesMatch("", "https://github.com/acme/app")).toBe(false)
    expect(canonicalRepositoryUrl("not a url")).toBeUndefined()
  })

  it("handles scp-like paths that begin with digits", () => {
    expect(canonicalRepositoryUrl("git@host.example:123/repo.git")).toBe("host.example/123/repo")
  })
})
