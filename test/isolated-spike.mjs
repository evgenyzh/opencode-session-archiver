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
  fetch: (request) => fetch(request, { signal: AbortSignal.timeout(2_000) }),
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
  const child = await client.session.create({ parentID: rootID, title: "session-archiver spike child" })
  if (!child.data) throw new Error(`Could not create child session: ${String(child.error)}`)
  childID = child.data.id

  const removed = await client.session.delete({ sessionID: rootID })
  if (!removed.data) throw new Error(`Could not delete root session: ${String(removed.error)}`)
  const root = await client.session.get({ sessionID: rootID })
  const descendant = await client.session.get({ sessionID: childID })
  if (root.data || descendant.data) throw new Error("Session deletion did not cascade to the disposable child")
  console.log("Spike passed: SDK create, child relationship, delete, and cascade verification.")
} finally {
  for (const sessionID of [rootID, childID].filter(Boolean)) {
    await client.session.delete({ sessionID }).catch(() => undefined)
  }
  server.kill("SIGTERM")
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))])
}
