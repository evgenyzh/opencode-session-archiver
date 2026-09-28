import { describe, expect, it } from "vitest"
import { deletePreparedArchive, prepareArchive, type ArchiveClient } from "../src/archive.js"

const source = {
  id: "ses_source",
  title: "Original",
  projectID: "prj_test",
  directory: "/tmp/archive-test",
  slug: "original",
  version: "1.18.21",
  time: { created: 1, updated: 1 },
}

const user = {
  id: "msg_user",
  sessionID: source.id,
  role: "user" as const,
  time: { created: 1 },
  agent: "build",
  model: { providerID: "openai", modelID: "gpt-test" },
}

const compactionUser = {
  id: "msg_compact",
  sessionID: source.id,
  role: "user" as const,
  time: { created: 2 },
  agent: "build",
  model: user.model,
}

const summaryAssistant = {
  id: "msg_summary",
  sessionID: source.id,
  role: "assistant" as const,
  parentID: "msg_compact",
  time: { created: 3 },
  modelID: "gpt-test",
  providerID: "openai",
  mode: "compaction",
  agent: "compaction",
  path: { cwd: "/tmp", root: "/tmp" },
  summary: true,
  finish: "stop",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const taskAssistant = {
  id: "msg_task",
  sessionID: source.id,
  role: "assistant" as const,
  parentID: user.id,
  time: { created: 1 },
  modelID: "gpt-test",
  providerID: "openai",
  agent: "build",
  mode: "primary",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

function textPart(messageID: string, text: string) {
  return { id: `part_${messageID}`, sessionID: source.id, messageID, type: "text" as const, text }
}

function client(opts: {
  overrides?: Partial<ArchiveClient["session"]>
  precompacted?: boolean
  onSummarize?: () => void
  extraSessions?: string[]
} = {}): ArchiveClient {
  let exists = new Set([source.id, "ses_child", ...(opts.extraSessions ?? [])])
  let compacted = opts.precompacted ?? false
  const deletedMessages = new Set<string>()
  const deletedSessions = new Set<string>()

  const messagesFor = (sessionID: string) => {
    if (sessionID !== source.id) return []
    const base = [
      { info: user, parts: [textPart(user.id, "Work")] },
      {
        info: taskAssistant,
        parts: [{
          id: "part_task",
          sessionID,
          messageID: taskAssistant.id,
          type: "tool" as const,
          callID: "call1",
          tool: "task",
          state: {
            status: "completed" as const,
            input: { prompt: "probe it", description: "probe", subagent_type: "explore" },
            output: "done",
            title: "probe",
            metadata: { sessionId: "ses_child", parentSessionId: source.id },
            time: { start: 1, end: 2 },
          },
        }],
      },
      ...(compacted ? [
        { info: compactionUser, parts: [{ id: "part_compact", sessionID, messageID: compactionUser.id, type: "compaction" as const, auto: false }] },
        { info: summaryAssistant, parts: [textPart(summaryAssistant.id, "Concise summary")] },
      ] : []),
    ]
    return base.filter((entry) => !deletedMessages.has(entry.info.id))
  }

  return {
    session: {
      get: async ({ sessionID }) =>
        exists.has(sessionID) && !deletedSessions.has(sessionID)
          ? { data: sessionID === source.id ? source : { ...source, id: sessionID } }
          : { error: new Error("not found") },
      children: async ({ sessionID }) => ({
        data: sessionID === source.id
          ? [{ ...source, id: "ses_child", parentID: source.id, agent: "explore", title: "probe (@explore subagent)" }]
          : [],
      }),
      status: async () => ({ data: {} }),
      messages: async ({ sessionID }) => ({ data: messagesFor(sessionID) }),
      summarize: async () => { compacted = true; opts.onSummarize?.(); return { data: true } },
      deleteMessage: async ({ messageID }) => { deletedMessages.add(messageID); return { data: {} } },
      delete: async ({ sessionID }) => { deletedSessions.add(sessionID); exists.delete(sessionID); return { data: true } },
      ...opts.overrides,
    },
  }
}

describe("archive workflow", () => {
  it("keeps only the compaction pair and deletes other messages and agent children", async () => {
    const sdk = client()
    const prepared = await prepareArchive(sdk, source.id)
    expect(prepared.keepMessageIDs).toEqual(["msg_compact", "msg_summary"])
    expect(prepared.deleteMessageIDs).toEqual([user.id, taskAssistant.id])
    expect(prepared.agentChildIDs).toEqual(["ses_child"])
    expect(prepared.orphanChildIDs).toEqual([])

    await deletePreparedArchive(sdk, prepared)
    const after = (await sdk.session.messages({ sessionID: source.id })).data!.map((entry) => entry.info.id)
    expect(after).toEqual(["msg_compact", "msg_summary"])
    expect((await sdk.session.get({ sessionID: "ses_child" })).data).toBeUndefined()
  })

  it("reuses an existing up-to-date compaction without re-summarizing", async () => {
    let summarizeCalls = 0
    const sdk = client({ precompacted: true, onSummarize: () => summarizeCalls++ })
    await prepareArchive(sdk, source.id)
    expect(summarizeCalls).toBe(0)
  })

  it("compacts when there is no summary yet", async () => {
    let summarizeCalls = 0
    const sdk = client({ onSummarize: () => summarizeCalls++ })
    await prepareArchive(sdk, source.id)
    expect(summarizeCalls).toBe(1)
  })

  it("does not treat a non-task child as deletable", async () => {
    const sdk = client({
      overrides: {
        children: async () => ({ data: [{ ...source, id: "ses_manual", parentID: source.id, agent: "build", title: "Manual child" }] }),
      },
    })
    const prepared = await prepareArchive(sdk, source.id)
    expect(prepared.agentChildIDs).toEqual([])
    expect(prepared.orphanChildIDs).toEqual([])
  })

  it("deletes orphaned subagent children that lost their task evidence", async () => {
    const sdk = client({
      extraSessions: ["ses_orphan"],
      overrides: {
        children: async () => ({
          data: [
            { ...source, id: "ses_child", parentID: source.id, agent: "explore", title: "probe (@explore subagent)" },
            { ...source, id: "ses_orphan", parentID: source.id, agent: "general", title: "Loose end (@general subagent)" },
          ],
        }),
      },
    })
    const prepared = await prepareArchive(sdk, source.id)
    expect(prepared.agentChildIDs).toEqual(["ses_child"])
    expect(prepared.orphanChildIDs).toEqual(["ses_orphan"])

    await deletePreparedArchive(sdk, prepared)
    expect((await sdk.session.get({ sessionID: "ses_child" })).data).toBeUndefined()
    expect((await sdk.session.get({ sessionID: "ses_orphan" })).data).toBeUndefined()
  })

  it("refuses a child session", async () => {
    const childSource = { ...source, id: "ses_child_source", parentID: "ses_root" }
    const sdk = client({ overrides: { get: async () => ({ data: childSource }) } })
    await expect(prepareArchive(sdk, "ses_child_source")).rejects.toThrow("child session")
  })

  it("refuses an active session", async () => {
    const sdk = client({ overrides: { status: async () => ({ data: { ses_source: { type: "busy" } } }) } })
    await expect(prepareArchive(sdk, source.id)).rejects.toThrow("still active")
  })

  it("verifies that OpenCode actually removed every message", async () => {
    const sdk = client({ overrides: { deleteMessage: async () => ({ data: {} }) } })
    const prepared = await prepareArchive(sdk, source.id)
    await expect(deletePreparedArchive(sdk, prepared)).rejects.toThrow("did not delete")
  })
})
