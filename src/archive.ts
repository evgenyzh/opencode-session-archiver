import type { OpenCodeClient, OpenCodeEvent, SessionInfo, SessionMessageCompactionCompleted, SessionMessageInfo } from "@opencode/client"

type SessionClient = Pick<OpenCodeClient["session"], "get" | "list" | "active" | "compact" | "remove">
type MessageClient = Pick<OpenCodeClient["message"], "list">
type EventClient = Pick<OpenCodeClient["event"], "subscribe">

export type ArchiveClient = {
  session: SessionClient
  message: MessageClient
  event: EventClient
}

export type PreparedArchive = {
  sourceID: string
  source: SessionInfo
  keepMessageIDs: string[]
  deleteMessageIDs: string[]
  agentChildIDs: string[]
  orphanChildIDs: string[]
  summaryChars: number
}

const PAGE_LIMIT = 200
const MAX_PAGES = 200
const CHILD_CONCURRENCY = 4
const COMPACTION_TIMEOUT_MS = 10 * 60 * 1000
const CONTENT_TYPES = new Set(["user", "assistant", "synthetic", "shell", "skill", "compaction"])

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Unknown OpenCode API error"
}

async function each<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift() as T
      await run(item)
    }
  }
  const results = await Promise.allSettled(Array.from({ length: Math.min(limit, queue.length) }, worker))
  const failed = results.find((result) => result.status === "rejected")
  if (failed?.status === "rejected") throw failed.reason
}

async function allMessages(client: ArchiveClient, sessionID: string): Promise<SessionMessageInfo[]> {
  const messages: SessionMessageInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.message.list(
      cursor === undefined
        ? { sessionID, order: "asc", limit: PAGE_LIMIT }
        : { sessionID, limit: PAGE_LIMIT, cursor },
    )
    messages.push(...response.data)
    const next = response.cursor.next
    if (next === undefined || next === null || response.data.length === 0) return messages
    cursor = next
  }
  throw new Error("Could not read session messages: too many pages")
}

async function allChildren(client: ArchiveClient, sessionID: string): Promise<SessionInfo[]> {
  const children: SessionInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.session.list(
      cursor === undefined
        ? { parentID: sessionID, order: "asc", limit: PAGE_LIMIT }
        : { limit: PAGE_LIMIT, cursor },
    )
    children.push(...response.data)
    const next = response.cursor.next
    if (next === undefined || next === null || response.data.length === 0) return children
    cursor = next
  }
  throw new Error("Could not list child sessions: too many pages")
}

function isCompletedCompaction(candidate: SessionMessageInfo): candidate is SessionMessageCompactionCompleted {
  return candidate.type === "compaction" && candidate.status === "completed"
}

function latestCompletedCompaction(messages: SessionMessageInfo[]): SessionMessageCompactionCompleted | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (candidate !== undefined && isCompletedCompaction(candidate)) return candidate
  }
  return undefined
}

function isCurrentCompaction(messages: SessionMessageInfo[], summary: SessionMessageCompactionCompleted): boolean {
  const index = messages.findIndex((candidate) => candidate.id === summary.id)
  if (index < 0) return false
  return !messages.slice(index + 1).some((candidate) => CONTENT_TYPES.has(candidate.type))
}

async function waitForCompaction(
  client: ArchiveClient,
  sessionID: string,
  start: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController()
  const forward = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) forward()
  else signal?.addEventListener("abort", forward, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("Compaction timed out")), COMPACTION_TIMEOUT_MS)

  let markConnected: (() => void) | undefined
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve
  })
  let settle: ((error?: unknown) => void) | undefined
  const finished = new Promise<void>((resolve, reject) => {
    settle = (error?: unknown) => (error === undefined ? resolve() : reject(error))
  })

  const reader = (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: controller.signal, onActivity: () => markConnected?.() })) {
        if (event.type === "session.compaction.ended" && event.data.sessionID === sessionID) {
          settle?.()
          return
        }
        if (event.type === "session.compaction.failed" && event.data.sessionID === sessionID) {
          settle?.(new Error(`OpenCode compaction failed: ${event.data.error.message}`))
          return
        }
      }
      settle?.(new Error("OpenCode event stream ended before compaction finished"))
    } catch (error) {
      settle?.(controller.signal.aborted ? new Error("Compaction timed out") : error)
    }
  })()

  try {
    await Promise.race([connected, finished])
    await start()
    await finished
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forward)
    controller.abort()
    await reader.catch(() => undefined)
    await finished.catch(() => undefined)
  }
}

function isAgentChild(child: SessionInfo, parentID: string, parentMessages: SessionMessageInfo[]): boolean {
  if (child.parentID !== parentID) return false
  for (const entry of parentMessages) {
    if (entry.type !== "assistant") continue
    for (const content of entry.content) {
      if (content.type !== "tool" || content.name !== "task") continue
      if (content.state.status === "streaming") continue
      const metadata = content.state.metadata
      if (metadata === undefined) continue
      if (metadata.sessionId !== child.id || metadata.parentSessionId !== parentID) continue
      const input = content.state.input as { subagent_type?: unknown }
      if (typeof input.subagent_type === "string" && input.subagent_type !== child.agent) continue
      return true
    }
  }
  return false
}

function isOrphanSubagent(child: SessionInfo, parentID: string): boolean {
  if (child.parentID !== parentID) return false
  if (typeof child.agent !== "string" || child.agent.length === 0) return false
  if (typeof child.title !== "string") return false
  const match = /\(@([^()\s]+) subagent\)$/.exec(child.title)
  return match?.[1] === child.agent
}

export async function prepareArchive(client: ArchiveClient, sourceID: string, signal?: AbortSignal): Promise<PreparedArchive> {
  let source: SessionInfo
  try {
    source = await client.session.get({ sessionID: sourceID })
  } catch (error) {
    throw new Error(`Could not load session: ${message(error)}`)
  }
  if (source.parentID) throw new Error("Archive the root session, not a child session")

  const active = await client.session.active()
  if (active[sourceID] !== undefined) throw new Error("Session is still active; wait for it to become idle")

  let messages = await allMessages(client, sourceID)
  let summary = latestCompletedCompaction(messages)
  if (summary === undefined || !isCurrentCompaction(messages, summary)) {
    await waitForCompaction(
      client,
      sourceID,
      async () => {
        try {
          await client.session.compact({ sessionID: sourceID })
        } catch (error) {
          throw new Error(`Could not compact session: ${message(error)}`)
        }
      },
      signal,
    )
    messages = await allMessages(client, sourceID)
    summary = latestCompletedCompaction(messages)
  }
  if (summary === undefined) throw new Error("Compaction did not create a completed summary")

  const keep = new Set([summary.id])
  const deleteMessageIDs = messages.map((entry) => entry.id).filter((id) => !keep.has(id))

  const children = await allChildren(client, sourceID)
  const agentChildIDs = children.filter((child) => isAgentChild(child, sourceID, messages)).map((child) => child.id)
  const known = new Set(agentChildIDs)
  const orphanChildIDs = children
    .filter((child) => !known.has(child.id) && isOrphanSubagent(child, sourceID))
    .map((child) => child.id)

  return {
    sourceID,
    source,
    keepMessageIDs: [...keep],
    deleteMessageIDs,
    agentChildIDs,
    orphanChildIDs,
    summaryChars: summary.summary.length,
  }
}

export async function removeArchiveChildren(client: ArchiveClient, prepared: PreparedArchive): Promise<void> {
  const childIDs = [...prepared.agentChildIDs, ...prepared.orphanChildIDs]
  await each(childIDs, CHILD_CONCURRENCY, async (sessionID) => {
    try {
      await client.session.remove({ sessionID })
    } catch (error) {
      throw new Error(`Could not delete child session ${sessionID}: ${message(error)}`)
    }
  })
}

export async function verifyArchive(client: ArchiveClient, prepared: PreparedArchive): Promise<void> {
  const kept = new Set(prepared.keepMessageIDs)
  const after = await allMessages(client, prepared.sourceID)
  const survivors = after.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id)
  if (survivors.length > 0) throw new Error(`OpenCode did not delete: ${survivors.join(", ")}`)

  const remaining = new Set((await allChildren(client, prepared.sourceID)).map((child) => child.id))
  const children = [...prepared.agentChildIDs, ...prepared.orphanChildIDs].filter((id) => remaining.has(id))
  if (children.length > 0) throw new Error(`OpenCode did not delete child session: ${children.join(", ")}`)
}
