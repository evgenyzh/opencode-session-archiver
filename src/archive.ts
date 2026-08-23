import type { Message, Part, Session } from "@opencode-ai/sdk/v2"

const DEFAULT_MAX_TAIL_CHARS = 64_000
const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8_000

export type ArchiveOptions = {
  maxTailChars?: number
  maxToolOutputChars?: number
}

export type ArchiveClient = {
  session: {
    get(input: { sessionID: string }): Promise<Result<Session>>
    children(input: { sessionID: string }): Promise<Result<Session[]>>
    status(): Promise<Result<Record<string, { type: string }>>>
    messages(input: { sessionID: string }): Promise<Result<Array<{ info: Message; parts: Part[] }>>>
    summarize(input: { sessionID: string; providerID: string; modelID: string; auto: boolean }): Promise<Result<boolean>>
    create(input: {
      title: string
      agent?: string
      model?: { providerID: string; id: string; variant?: string }
      workspaceID?: string
      permission?: Session["permission"]
    }): Promise<Result<Session>>
    prompt(input: {
      sessionID: string
      noReply: true
      agent?: string
      model?: { providerID: string; modelID: string }
      parts: Array<{ type: "text"; text: string; synthetic?: boolean }>
    }): Promise<Result<unknown>>
    delete(input: { sessionID: string }): Promise<Result<boolean>>
  }
}

export type Result<T> = { data?: T; error?: unknown }

export type ArchivePlan = {
  source: Session
  target: Session
  descendantIDs: string[]
  summaryChars: number
  tailChars: number
}

export type PreparedArchive = ArchivePlan & {
  sourceID: string
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

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 28))}\n[truncated by session archiver]`
}

function text(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
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

function describePart(part: Part, maxToolOutputChars: number): string | undefined {
  if (part.type === "text") return part.text
  if (part.type === "tool") {
    const state = part.state
    const input = JSON.stringify(state.input)
    if (state.status === "completed") {
      return `[tool ${part.tool}]\ninput: ${input}\noutput:\n${truncate(state.output, maxToolOutputChars)}`
    }
    if (state.status === "error") return `[tool ${part.tool}]\ninput: ${input}\nerror: ${state.error}`
    return `[tool ${part.tool}]\ninput: ${input}\nstatus: ${state.status}`
  }
  if (part.type === "subtask") return `[subtask ${part.agent}] ${part.description}\nprompt: ${part.prompt}`
  if (part.type === "file") return `[file ${part.filename ?? "attachment"}] ${part.mime}`
  if (part.type === "patch") return `[patch] files: ${part.files.join(", ")}`
  return undefined
}

export function serializeTail(messages: WithParts[], tailStartID: string | undefined, options: ArchiveOptions = {}): string {
  const maxTailChars = options.maxTailChars ?? DEFAULT_MAX_TAIL_CHARS
  const maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS
  const start = tailStartID ? messages.findIndex((entry) => entry.info.id === tailStartID) : -1
  const candidates = messages.slice(Math.max(0, start)).filter((entry) => {
    return !(entry.info.role === "assistant" && entry.info.summary)
  })
  const blocks = candidates.map((entry) => {
    const body = entry.parts
      .map((part) => describePart(part, maxToolOutputChars))
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n")
    return body ? `### ${entry.info.role}\n${body}` : ""
  }).filter(Boolean)

  const kept: string[] = []
  let used = 0
  for (const block of [...blocks].reverse()) {
    const separator = kept.length === 0 ? 0 : 2
    if (used + separator + block.length > maxTailChars) {
      if (kept.length === 0) kept.unshift(truncate(block, maxTailChars))
      break
    }
    kept.unshift(block)
    used += separator + block.length
  }
  return kept.join("\n\n")
}

async function descendantIDs(client: ArchiveClient, sessionID: string): Promise<string[]> {
  const result: string[] = []
  for (const child of await data(client.session.children({ sessionID }), "Could not list child sessions")) {
    result.push(child.id, ...(await descendantIDs(client, child.id)))
  }
  return result
}

function latestUser(messages: WithParts[]): Extract<Message, { role: "user" }> {
  const user = [...messages].reverse().find((entry: WithParts) => entry.info.role === "user")?.info
  if (!user || user.role !== "user") throw new Error("Session has no user message with a model selection")
  return user
}

function summaryTailStart(messages: WithParts[], summary: WithParts): string | undefined {
  const parentID = "parentID" in summary.info ? summary.info.parentID : undefined
  if (!parentID) return undefined
  const parent = messages.find((entry) => entry.info.id === parentID)
  const compaction = parent?.parts.find((part): part is Extract<Part, { type: "compaction" }> => part.type === "compaction")
  return compaction?.tail_start_id
}

export async function prepareArchive(
  client: ArchiveClient,
  sourceID: string,
  title: string | undefined,
  options: ArchiveOptions = {},
): Promise<PreparedArchive> {
  const source = await data(client.session.get({ sessionID: sourceID }), "Could not load source session")
  if (source.parentID) throw new Error("Archive the root session, not a child session")

  const statuses = await data(client.session.status(), "Could not read session status")
  const descendants = await descendantIDs(client, sourceID)
  const active = [sourceID, ...descendants].find((id) => statuses[id]?.type === "busy" || statuses[id]?.type === "retry")
  if (active) throw new Error(`Session ${active} is still active; wait for it to become idle`)

  const before = await data(client.session.messages({ sessionID: sourceID }), "Could not read source messages")
  const user = latestUser(before)
  const knownSummaryIDs = new Set(before.filter((entry) => entry.info.role === "assistant" && entry.info.summary).map((entry) => entry.info.id))
  await data(
    client.session.summarize({
      sessionID: sourceID,
      providerID: user.model.providerID,
      modelID: user.model.modelID,
      auto: false,
    }),
    "Could not compact source session",
  )
  const after = await data(client.session.messages({ sessionID: sourceID }), "Could not read compacted session")
  const summary = completedSummary(after, knownSummaryIDs)
  const summaryText = text(summary.parts)
  const tail = serializeTail(after, summaryTailStart(after, summary), options)
  const targetTitle = title?.trim() || source.title
  const target = await data(
    client.session.create({
      title: targetTitle,
      agent: user.agent,
      model: { providerID: user.model.providerID, id: user.model.modelID, variant: user.model.variant },
      workspaceID: source.workspaceID,
      permission: source.permission,
    }),
    "Could not create replacement session",
  )
  const imported = [
    "# Archived session context",
    `Source: ${source.title} (${source.id})`,
    `Archived: ${new Date().toISOString()}`,
    "## Compaction summary",
    summaryText,
    tail ? `## Recent tail\n${tail}` : "",
  ].filter(Boolean).join("\n\n")
  try {
    await data(
      client.session.prompt({
        sessionID: target.id,
        noReply: true,
        agent: user.agent,
        model: { providerID: user.model.providerID, modelID: user.model.modelID },
        parts: [{ type: "text", text: imported }],
      }),
      "Could not import compact context",
    )
  } catch (error) {
    await client.session.delete({ sessionID: target.id })
    throw error
  }
  const persisted = await data(client.session.messages({ sessionID: target.id }), "Could not verify replacement session")
  if (!persisted.some((entry) => entry.parts.some((part) => part.type === "text" && !part.synthetic && part.text === imported))) {
    await client.session.delete({ sessionID: target.id })
    throw new Error("Replacement session did not retain the imported context")
  }
  return { sourceID, source, target, descendantIDs: descendants, summaryChars: summaryText.length, tailChars: tail.length }
}

export async function deletePreparedArchive(client: ArchiveClient, prepared: PreparedArchive): Promise<void> {
  await data(client.session.delete({ sessionID: prepared.sourceID }), "Could not delete source session")
  const survivors: string[] = []
  for (const sessionID of [prepared.sourceID, ...prepared.descendantIDs]) {
    const result = await client.session.get({ sessionID })
    if (result.data !== undefined) survivors.push(sessionID)
  }
  if (survivors.length > 0) throw new Error(`OpenCode did not delete: ${survivors.join(", ")}`)
}
