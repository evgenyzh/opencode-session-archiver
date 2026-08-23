import type { Message, Part, Session } from "@opencode-ai/sdk/v2"

export type ArchiveClient = {
  session: {
    get(input: { sessionID: string }): Promise<Result<Session>>
    children(input: { sessionID: string }): Promise<Result<Session[]>>
    status(): Promise<Result<Record<string, { type: string }>>>
    messages(input: { sessionID: string }): Promise<Result<Array<{ info: Message; parts: Part[] }>>>
    summarize(input: { sessionID: string; providerID: string; modelID: string; auto: boolean }): Promise<Result<boolean>>
    deleteMessage(input: { sessionID: string; messageID: string }): Promise<Result<unknown>>
    delete(input: { sessionID: string }): Promise<Result<boolean>>
  }
}

export type Result<T> = { data?: T; error?: unknown }

export type PreparedArchive = {
  sourceID: string
  source: Session
  keepMessageIDs: string[]
  deleteMessageIDs: string[]
  agentChildIDs: string[]
  summaryChars: number
}

type WithParts = { info: Message; parts: Part[] }

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Unknown OpenCode API error"
}

async function data<T>(request: Promise<Result<T>>, action: string): Promise<T> {
  const result = await request
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(`${action}: ${message(result.error)}`)
  }
  return result.data
}

function text(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function latestCompletedSummary(messages: WithParts[]): WithParts | undefined {
  return [...messages].reverse().find(
    (entry: WithParts) =>
      entry.info.role === "assistant" &&
      entry.info.summary === true &&
      entry.info.finish !== undefined &&
      entry.info.error === undefined &&
      text(entry.parts).length > 0,
  )
}

function completedSummary(messages: WithParts[], beforeIDs: Set<string>): WithParts {
  const summary = [...messages].reverse().find(
    (entry: WithParts) =>
      entry.info.role === "assistant" &&
      entry.info.summary === true &&
      entry.info.finish !== undefined &&
      entry.info.error === undefined &&
      !beforeIDs.has(entry.info.id) &&
      text(entry.parts).length > 0,
  )
  if (!summary) throw new Error("Compaction did not create a completed summary")
  return summary
}

function latestUser(messages: WithParts[]): Extract<Message, { role: "user" }> {
  const user = [...messages].reverse().find((entry: WithParts) => entry.info.role === "user")?.info
  if (!user || user.role !== "user") throw new Error("Session has no user message with a model selection")
  return user
}

function compactionPair(messages: WithParts[], summary: WithParts): { parent: WithParts; summary: WithParts } {
  const parentID = "parentID" in summary.info ? summary.info.parentID : undefined
  if (!parentID) throw new Error("Compaction summary has no parent message")
  const parent = messages.find((entry) => entry.info.id === parentID)
  if (!parent) throw new Error("Compaction summary parent message is missing")
  if (parent.info.role !== "user" || !parent.parts.some((part) => part.type === "compaction")) {
    throw new Error("Compaction summary parent is not a compaction message")
  }
  return { parent, summary }
}

function isAgentChild(child: Session, parentID: string, parentMessages: WithParts[]): boolean {
  if (child.parentID !== parentID) return false
  for (const entry of parentMessages) {
    if (entry.info.role !== "assistant") continue
    for (const part of entry.parts) {
      if (part.type !== "tool" || part.tool !== "task") continue
      const state = part.state
      const metadata = state.status === "pending" ? undefined : state.metadata
      if (!metadata) continue
      if (metadata.sessionId !== child.id || metadata.parentSessionId !== parentID) continue
      const input = part.state.input as { subagent_type?: unknown }
      if (typeof input.subagent_type === "string" && input.subagent_type !== child.agent) continue
      return true
    }
  }
  return false
}

export async function prepareArchive(client: ArchiveClient, sourceID: string): Promise<PreparedArchive> {
  const source = await data(client.session.get({ sessionID: sourceID }), "Could not load session")
  if (source.parentID) throw new Error("Archive the root session, not a child session")

  const statuses = await data(client.session.status(), "Could not read session status")
  if (statuses[sourceID]?.type === "busy" || statuses[sourceID]?.type === "retry") {
    throw new Error("Session is still active; wait for it to become idle")
  }

  const before = await data(client.session.messages({ sessionID: sourceID }), "Could not read session messages")
  const user = latestUser(before)
  const existingSummary = latestCompletedSummary(before)
  const existingIndex = existingSummary ? before.indexOf(existingSummary) : -1
  const needsCompaction = !existingSummary || existingIndex !== before.length - 1

  let after = before
  let summary = existingSummary
  if (needsCompaction) {
    const known = new Set(
      before.filter((entry) => entry.info.role === "assistant" && entry.info.summary).map((entry) => entry.info.id),
    )
    await data(
      client.session.summarize({
        sessionID: sourceID,
        providerID: user.model.providerID,
        modelID: user.model.modelID,
        auto: false,
      }),
      "Could not compact session",
    )
    after = await data(client.session.messages({ sessionID: sourceID }), "Could not read compacted session")
    summary = completedSummary(after, known)
  }
  if (!summary) throw new Error("Could not identify a completed compaction summary")

  const pair = compactionPair(after, summary)
  const keep = new Set([pair.parent.info.id, pair.summary.info.id])
  const deleteMessageIDs = after.map((entry) => entry.info.id).filter((id) => !keep.has(id))

  const children = await data(client.session.children({ sessionID: sourceID }), "Could not list child sessions")
  const agentChildIDs = children.filter((child) => isAgentChild(child, sourceID, after)).map((child) => child.id)

  return {
    sourceID,
    source,
    keepMessageIDs: [...keep],
    deleteMessageIDs,
    agentChildIDs,
    summaryChars: text(pair.summary.parts).length,
  }
}

export async function deletePreparedArchive(client: ArchiveClient, prepared: PreparedArchive): Promise<void> {
  for (const messageID of prepared.deleteMessageIDs) {
    await data(
      client.session.deleteMessage({ sessionID: prepared.sourceID, messageID }),
      `Could not delete message ${messageID}`,
    )
  }
  for (const sessionID of prepared.agentChildIDs) {
    await data(client.session.delete({ sessionID }), `Could not delete child session ${sessionID}`)
  }

  const kept = new Set(prepared.keepMessageIDs)
  const after = await data(client.session.messages({ sessionID: prepared.sourceID }), "Could not verify session")
  const survivors = after.filter((entry) => !kept.has(entry.info.id)).map((entry) => entry.info.id)
  if (survivors.length > 0) throw new Error(`OpenCode did not delete: ${survivors.join(", ")}`)

  for (const sessionID of prepared.agentChildIDs) {
    const result = await client.session.get({ sessionID })
    if (result.data !== undefined) throw new Error(`OpenCode did not delete child session: ${sessionID}`)
  }
}
