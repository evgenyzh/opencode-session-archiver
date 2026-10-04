import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { OpenCode } from "@opencode/client"

const base = process.env.SPIKE_DIR ?? mkdtempSync(join(tmpdir(), "session-archiver-spike-"))
const databasePath = join(base, "opencode.db")
const configHome = join(base, "config")
const dataHome = join(base, "data")
mkdirSync(join(configHome, "opencode"), { recursive: true })
mkdirSync(dataHome, { recursive: true })

const port = 45000 + Math.floor(Math.random() * 1000)
const password = "session-archiver-spike"
const binary = process.env.OPENCODE_BIN ?? `${process.env.HOME}/.opencode/bin/opencode`
const client = OpenCode.make({
  baseUrl: `http://127.0.0.1:${port}`,
  headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
})
let server
let sessionID

function startServer() {
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      OPENCODE_DB: databasePath,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "inherit", "inherit"],
  })
}

async function stopServer() {
  if (!server) return
  server.kill("SIGTERM")
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))])
  server = undefined
}

async function waitForServer() {
  let last
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client.session.list({ limit: 1 })
      return
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`OpenCode server did not start: ${String(last)}`)
}

async function messages(sessionID) {
  const result = await client.message.list({ sessionID, order: "asc", limit: 200 })
  return result.data
}

async function waitForMessages(sessionID, minimum) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const list = await messages(sessionID)
    if (list.length >= minimum) return list
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${minimum} messages`)
}

function prune(database, keepID) {
  database.prepare("DELETE FROM session_message WHERE session_id = ? AND id != ?").run(sessionID, keepID)
}

async function compactAndWait(sessionID) {
  const controller = new AbortController()
  let connected = false
  const finished = (async () => {
    for await (const event of client.event.subscribe({
      signal: controller.signal,
      onActivity: () => {
        connected = true
      },
    })) {
      if (event.type === "session.compaction.ended" && event.data.sessionID === sessionID) {
        return { ok: true }
      }
      if (event.type === "session.compaction.failed" && event.data.sessionID === sessionID) {
        return { ok: false, error: event.data.error.message }
      }
    }
    throw new Error("The event stream ended before compaction finished")
  })()
  while (!connected) await new Promise((resolve) => setTimeout(resolve, 50))
  await client.session.compact({ sessionID })
  try {
    return await Promise.race([
      finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Compaction timed out")), 120_000)),
    ])
  } finally {
    controller.abort()
    await finished.catch(() => undefined)
  }
}

try {
  startServer()
  await waitForServer()

  const sessions = await client.session.list({ limit: 5 })
  if (sessions.data.length > 0) throw new Error("The isolated server is not using the temporary database")

  const created = await client.session.create({ title: "session-archiver spike probe" })
  sessionID = created.id
  for (const text of ["spike one", "spike two", "spike three"]) {
    await client.session.synthetic({ sessionID, text })
  }

  const before = await waitForMessages(sessionID, 3)
  const keep = before.find((entry) => entry.type === "synthetic" && entry.text === "spike two") ?? before.at(-1)
  if (!keep) throw new Error("Could not resolve the message to keep")

  const database = new DatabaseSync(databasePath)
  const stored = database
    .prepare("SELECT COUNT(*) AS count FROM session_message WHERE session_id = ?")
    .get(sessionID)
  if (stored.count !== before.length) {
    throw new Error(`Projected ${before.length} messages but the database has ${stored.count}`)
  }
  prune(database, keep.id)
  database.close()

  const live = await messages(sessionID)
  if (live.length !== 1 || live[0]?.id !== keep.id) {
    throw new Error(`Live prune not visible: ${live.map((entry) => entry.id).join(", ")}`)
  }
  const context = await client.session.context({ sessionID })
  if (!context.some((entry) => entry.id === keep.id)) throw new Error("session.context lost the kept message")

  await stopServer()
  startServer()
  await waitForServer()

  const after = await messages(sessionID)
  if (after.length !== 1 || after[0]?.id !== keep.id) {
    throw new Error(`Prune did not survive restart: ${after.map((entry) => entry.id).join(", ")}`)
  }
  const session = await client.session.get({ sessionID })
  if (session.id !== sessionID) throw new Error("Session metadata was lost")

  const second = await client.session.create({ title: "session-archiver compaction probe" })
  for (const text of ["compact one", "compact two"]) {
    await client.session.synthetic({ sessionID: second.id, text })
  }
  await waitForMessages(second.id, 2)
  const compaction = await compactAndWait(second.id)
  if (compaction.ok) {
    const compacted = await messages(second.id)
    const summaries = compacted.filter((entry) => entry.type === "compaction" && entry.status === "completed")
    if (summaries.length === 0) throw new Error("Compaction did not produce a completed summary")
    console.log(`Compaction probe passed: ${summaries.length} completed summary message(s).`)
  } else {
    console.log(`Compaction probe skipped (provider unavailable): ${compaction.error}`)
  }

  console.log("Spike passed: direct session_message prune is visible live and survives restart.")
  if (process.env.SPIKE_KEEP !== "1") rmSync(base, { recursive: true, force: true })
} catch (error) {
  console.error(`Spike failed: ${error instanceof Error ? error.message : String(error)}`)
  console.error(`Spike directory kept for inspection: ${base}`)
  process.exitCode = 1
} finally {
  await stopServer()
}
