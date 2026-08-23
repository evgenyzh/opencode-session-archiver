import { spawn } from "node:child_process"
import { once } from "node:events"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const port = 45000 + Math.floor(Math.random() * 1000)
const binary = process.env.OPENCODE_BIN ?? `${process.env.HOME}/.opencode/bin/opencode`
const server = spawn(binary, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: process.cwd(),
  stdio: "inherit",
})
const client = createOpencodeClient({
  baseUrl: `http://127.0.0.1:${port}`,
  directory: process.cwd(),
  fetch: (request) => fetch(request, { signal: AbortSignal.timeout(5_000) }),
})
let rootID
let childID

async function waitForServer() {
  let last
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const result = await client.session.create({ title: "session-archiver spike probe" })
    if (result.data) {
      rootID = result.data.id
      return
    }
    last = result.error
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode server did not start: ${String(last)}`)
}

try {
  await waitForServer()

  const prompted = await client.session.prompt({
    sessionID: rootID,
    noReply: true,
    parts: [{ type: "text", text: "spike message" }],
  })
  if (prompted.error !== undefined || prompted.data === undefined) {
    throw new Error(`Could not create a message: ${String(prompted.error)}`)
  }

  const before = await client.session.messages({ sessionID: rootID })
  const messageID = before.data?.find((entry) => entry.parts.some((part) => part.type === "text" && part.text === "spike message"))?.info.id
  if (!messageID) throw new Error("The spike message was not persisted")

  const removed = await client.session.deleteMessage({ sessionID: rootID, messageID })
  if (removed.error !== undefined || removed.data === undefined) {
    throw new Error(`deleteMessage failed: ${String(removed.error)}`)
  }
  const after = await client.session.messages({ sessionID: rootID })
  if (after.data?.some((entry) => entry.info.id === messageID)) {
    throw new Error("deleteMessage did not remove the message")
  }

  const child = await client.session.create({ parentID: rootID, title: "session-archiver spike child" })
  if (!child.data) throw new Error(`Could not create child session: ${String(child.error)}`)
  childID = child.data.id

  const deleted = await client.session.delete({ sessionID: rootID })
  if (!deleted.data) throw new Error(`Could not delete root session: ${String(deleted.error)}`)
  const root = await client.session.get({ sessionID: rootID })
  const descendant = await client.session.get({ sessionID: childID })
  if (root.data || descendant.data) throw new Error("Session deletion did not cascade to the child")
  console.log("Spike passed: message delete, child cascade, and verification.")
} finally {
  for (const sessionID of [rootID, childID].filter(Boolean)) {
    await client.session.delete({ sessionID }).catch(() => undefined)
  }
  server.kill("SIGTERM")
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))])
}
