import { describe, expect, it } from "vitest"
import { deletePreparedArchive, prepareArchive, serializeTail, type ArchiveClient } from "../src/archive.js"

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

function client(overrides: Partial<ArchiveClient["session"]> = {}): ArchiveClient {
  let exists = new Set([source.id, "ses_child", "ses_target"])
  let compacted = false
  let imported = ""
  return {
    session: {
      get: async ({ sessionID }) => exists.has(sessionID) ? { data: sessionID === source.id ? source : { ...source, id: sessionID } } : { error: new Error("not found") },
      children: async ({ sessionID }) => ({ data: sessionID === source.id ? [{ ...source, id: "ses_child", parentID: source.id }] : [] }),
      status: async () => ({ data: {} }),
      messages: async ({ sessionID }) => ({
        data: sessionID === source.id ? [
          { info: user, parts: [{ id: "part_user", sessionID, messageID: user.id, type: "text" as const, text: "Work" }] },
          ...(compacted ? [
          { info: { id: "msg_compact", sessionID, role: "user" as const, time: { created: 2 }, agent: "build", model: user.model }, parts: [{ id: "part_compact", sessionID, messageID: "msg_compact", type: "compaction" as const, auto: false }] },
          { info: { id: "msg_summary", sessionID, role: "assistant" as const, parentID: "msg_compact", time: { created: 3 }, modelID: "gpt-test", providerID: "openai", mode: "compaction", agent: "compaction", path: { cwd: "/tmp", root: "/tmp" }, summary: true, finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ id: "part_summary", sessionID, messageID: "msg_summary", type: "text" as const, text: "Concise summary" }] },
          ] : []),
        ] : [{ info: user, parts: [{ id: "part_import", sessionID, messageID: user.id, type: "text" as const, text: imported }] }],
      }),
      summarize: async () => { compacted = true; return { data: true } },
      create: async () => ({ data: { ...source, id: "ses_target", title: "Replacement" } }),
      prompt: async (input) => { imported = input.parts[0]?.text ?? ""; return { data: {} } },
      delete: async ({ sessionID }) => { exists.delete(sessionID); if (sessionID === source.id) exists.delete("ses_child"); return { data: true } },
      ...overrides,
    },
  }
}

describe("serializeTail", () => {
  it("keeps the newest blocks within the configured limit", () => {
    const messages = [
      { info: user, parts: [{ id: "old", sessionID: source.id, messageID: user.id, type: "text" as const, text: "old".repeat(100) }] },
      { info: { ...user, id: "msg_new" }, parts: [{ id: "new", sessionID: source.id, messageID: "msg_new", type: "text" as const, text: "newest" }] },
    ]
    const tail = serializeTail(messages, undefined, { maxTailChars: 30 })
    expect(tail).toContain("newest")
    expect(tail.length).toBeLessThanOrEqual(30)
  })

  it("truncates completed tool output", () => {
    const tail = serializeTail([{ info: user, parts: [{ id: "tool", sessionID: source.id, messageID: user.id, type: "tool" as const, callID: "call", tool: "bash", state: { status: "completed" as const, input: {}, output: "x".repeat(100), title: "bash", metadata: {}, time: { start: 0, end: 1 } } }] }], undefined, { maxToolOutputChars: 40 })
    expect(tail).toContain("[truncated by session archiver]")
  })
})

describe("archive workflow", () => {
  it("does not delete the source before explicit finalization", async () => {
    const sdk = client()
    const prepared = await prepareArchive(sdk, source.id, "Replacement")
    expect(prepared.target.id).toBe("ses_target")
    expect((await sdk.session.get({ sessionID: source.id })).data).toBeDefined()
  })

  it("persists the archive summary as a visible target message", async () => {
    await expect(prepareArchive(client(), source.id, "Replacement")).resolves.toMatchObject({ target: { id: "ses_target" } })
  })

  it("refuses active source descendants", async () => {
    await expect(prepareArchive(client({ status: async () => ({ data: { ses_child: { type: "busy" } } }) }), source.id, undefined)).rejects.toThrow("still active")
  })

  it("checks that OpenCode actually removed every session", async () => {
    const sdk = client({ delete: async () => ({ data: true }) })
    await expect(deletePreparedArchive(sdk, { sourceID: source.id, source, target: { ...source, id: "ses_target" }, descendantIDs: ["ses_child"], summaryChars: 1, tailChars: 0 })).rejects.toThrow("did not delete")
  })
})
