import type {
  OpenCodeEvent,
  SessionInfo,
  SessionInboxCompaction,
  SessionMessageAssistant,
  SessionMessageCompactionCompleted,
  SessionMessageInfo,
  SessionMessageUser,
} from "@opencode/client"
import { describe, expect, it } from "vitest"
import { prepareArchive, removeArchiveChildren, verifyArchive, type ArchiveClient } from "../src/archive.js"

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_source",
    projectID: "prj_test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "/tmp/archive-test" },
    ...overrides,
  }
}

const source = sessionInfo({ id: "ses_source", title: "Original" })

const user: SessionMessageUser = {
  id: "msg_user",
  time: { created: 1 },
  type: "user",
  text: "Work",
}

const taskAssistant: SessionMessageAssistant = {
  id: "msg_task",
  time: { created: 1 },
  type: "assistant",
  agent: "build",
  model: { id: "gpt-test", providerID: "openai" },
  content: [{
    type: "tool",
    id: "tool_task",
    name: "task",
    state: {
      status: "completed",
      input: { prompt: "probe it", description: "probe", subagent_type: "explore" },
      content: [{ type: "text", text: "done" }],
      metadata: { sessionId: "ses_child", parentSessionId: "ses_source" },
    },
    time: { created: 1, completed: 2 },
  }],
  finish: "tool-calls",
}

function compaction(): SessionMessageCompactionCompleted {
  return {
    id: "msg_compact",
    time: { created: 3 },
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "Concise summary",
    recent: "Recent conversation",
  }
}

function childSession(id: string, agent: string, title: string): SessionInfo {
  return sessionInfo({ id, parentID: source.id, agent, title })
}

type FakeOptions = {
  precompacted?: boolean
  active?: boolean
  children?: SessionInfo[]
  pageSize?: number
  removeChildren?: boolean
}

function client(options: FakeOptions = {}): {
  api: ArchiveClient
  compactCalls: () => number
  prune: () => void
} {
  const children = options.children ?? []
  const removed = new Set<string>()
  let summary = options.precompacted ? compaction() : undefined
  let pruned = false
  let compactCalls = 0
  let ended: OpenCodeEvent | undefined

  const messages = (): SessionMessageInfo[] => {
    if (pruned && summary) return [summary]
    const entries: SessionMessageInfo[] = [user, taskAssistant]
    if (summary) entries.push(summary)
    return entries
  }

  const chunks = (entries: SessionMessageInfo[]): SessionMessageInfo[][] => {
    if (!options.pageSize) return [entries]
    const result: SessionMessageInfo[][] = []
    for (let index = 0; index < entries.length; index += options.pageSize) {
      result.push(entries.slice(index, index + options.pageSize))
    }
    return result
  }

  const api: ArchiveClient = {
    session: {
      get: async ({ sessionID }) => {
        if (sessionID === source.id) return source
        const child = children.find((entry) => entry.id === sessionID)
        if (child && !removed.has(sessionID)) return child
        throw new Error("not found")
      },
      list: async () => ({ data: children.filter((child) => !removed.has(child.id)), cursor: { next: null } }),
      active: async () => (options.active ? { [source.id]: { type: "running" } } : {}),
      compact: async () => {
        compactCalls += 1
        summary = compaction()
        ended = { type: "session.compaction.ended", data: { sessionID: source.id } } as OpenCodeEvent
        return { id: "inbox_compact", sessionID: source.id } as SessionInboxCompaction
      },
      remove: async ({ sessionID }) => {
        if (options.removeChildren === false) return
        removed.add(sessionID)
      },
    },
    message: {
      list: async (input) => {
        const pages = chunks(messages())
        const index = input.cursor === undefined ? 0 : Number(input.cursor)
        const data = pages[index] ?? []
        const next = index + 1 < pages.length ? String(index + 1) : null
        return { data, cursor: { next } }
      },
    },
    event: {
      subscribe: (requestOptions) => (async function* () {
        requestOptions?.onActivity?.()
        for (let spins = 0; spins < 5_000; spins += 1) {
          if (requestOptions?.signal?.aborted) throw new Error("aborted")
          if (ended !== undefined) {
            const event = ended
            ended = undefined
            yield event
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      })(),
    },
  }
  return {
    api,
    compactCalls: () => compactCalls,
    prune: () => {
      pruned = true
    },
  }
}

describe("archive workflow", () => {
  it("keeps only the compaction and deletes other messages and agent children", async () => {
    const { api } = client({ children: [childSession("ses_child", "explore", "probe (@explore subagent)")] })
    const prepared = await prepareArchive(api, source.id)
    expect(prepared.keepMessageIDs).toEqual(["msg_compact"])
    expect(prepared.deleteMessageIDs).toEqual([user.id, taskAssistant.id])
    expect(prepared.agentChildIDs).toEqual(["ses_child"])
    expect(prepared.orphanChildIDs).toEqual([])
    expect(prepared.summaryChars).toBe("Concise summary".length)
  })

  it("reuses an existing up-to-date compaction without re-compacting", async () => {
    const { api, compactCalls } = client({ precompacted: true })
    await prepareArchive(api, source.id)
    expect(compactCalls()).toBe(0)
  })

  it("compacts when there is no summary yet", async () => {
    const { api, compactCalls } = client()
    await prepareArchive(api, source.id)
    expect(compactCalls()).toBe(1)
  })

  it("reads messages across pages", async () => {
    const { api } = client({ pageSize: 1, precompacted: true })
    const prepared = await prepareArchive(api, source.id)
    expect(prepared.deleteMessageIDs).toEqual([user.id, taskAssistant.id])
  })

  it("does not treat a non-task child as deletable", async () => {
    const { api } = client({ children: [childSession("ses_manual", "build", "Manual child")] })
    const prepared = await prepareArchive(api, source.id)
    expect(prepared.agentChildIDs).toEqual([])
    expect(prepared.orphanChildIDs).toEqual([])
  })

  it("deletes orphaned subagent children that lost their task evidence", async () => {
    const { api } = client({
      children: [
        childSession("ses_child", "explore", "probe (@explore subagent)"),
        childSession("ses_orphan", "general", "Loose end (@general subagent)"),
      ],
    })
    const prepared = await prepareArchive(api, source.id)
    expect(prepared.agentChildIDs).toEqual(["ses_child"])
    expect(prepared.orphanChildIDs).toEqual(["ses_orphan"])
  })

  it("refuses a child session", async () => {
    const { api } = client()
    const child = childSession("ses_child_source", "explore", "child")
    const clientWithChild: ArchiveClient = {
      ...api,
      session: { ...api.session, get: async () => ({ ...child, parentID: "ses_root" }) },
    }
    await expect(prepareArchive(clientWithChild, "ses_child_source")).rejects.toThrow("child session")
  })

  it("refuses an active session", async () => {
    const { api } = client({ active: true })
    await expect(prepareArchive(api, source.id)).rejects.toThrow("still active")
  })

  it("removes children and verifies the archive", async () => {
    const { api, prune } = client({ children: [childSession("ses_child", "explore", "probe (@explore subagent)")] })
    const prepared = await prepareArchive(api, source.id)
    await removeArchiveChildren(api, prepared)
    prune()
    await expect(verifyArchive(api, prepared)).resolves.toBeUndefined()
  })

  it("reports a surviving child session", async () => {
    const { api, prune } = client({
      children: [childSession("ses_child", "explore", "probe (@explore subagent)")],
      removeChildren: false,
    })
    const prepared = await prepareArchive(api, source.id)
    await removeArchiveChildren(api, prepared)
    prune()
    await expect(verifyArchive(api, prepared)).rejects.toThrow("did not delete child session")
  })

  it("reports messages that survived the purge", async () => {
    const { api } = client()
    const prepared = await prepareArchive(api, source.id)
    await expect(verifyArchive(api, prepared)).rejects.toThrow("OpenCode did not delete")
  })
})
