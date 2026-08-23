/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { deletePreparedArchive, prepareArchive, type PreparedArchive } from "./archive.js"

function askTitle(api: Parameters<TuiPluginModule["tui"]>[0]): Promise<{ cancelled: boolean; title?: string }> {
  return new Promise((resolve) => {
    const Prompt = api.ui.DialogPrompt
    api.ui.dialog.replace(
      () => <Prompt
        title="Archive session"
        placeholder="Optional replacement title; leave blank to keep current"
        onConfirm={(value) => { api.ui.dialog.clear(); resolve({ cancelled: false, title: value.trim() || undefined }) }}
        onCancel={() => { api.ui.dialog.clear(); resolve({ cancelled: true }) }}
      />,
      () => resolve({ cancelled: true }),
    )
  })
}

function confirm(api: Parameters<TuiPluginModule["tui"]>[0], prepared: PreparedArchive): Promise<boolean> {
  return new Promise((resolve) => {
    const Confirm = api.ui.DialogConfirm
    const message = [
      `New session: ${prepared.target.title}`,
      `Summary: ${prepared.summaryChars.toLocaleString()} chars; tail: ${prepared.tailChars.toLocaleString()} chars.`,
      `Delete ${prepared.source.title} and ${prepared.descendantIDs.length} child session(s)?`,
      "This cannot be undone.",
    ].join("\n")
    api.ui.dialog.replace(
      () => <Confirm title="Delete original session?" message={message} onConfirm={() => { api.ui.dialog.clear(); resolve(true) }} onCancel={() => { api.ui.dialog.clear(); resolve(false) }} />,
      () => resolve(false),
    )
  })
}

const tui: TuiPluginModule["tui"] = async (api) => {
  api.keymap.registerLayer({
    commands: [{
      namespace: "palette",
      name: "session-archiver.archive",
      title: "Archive current session",
      desc: "Create a compact replacement and delete the original after confirmation",
      category: "Session",
      slashName: "archive-session",
      enabled: () => api.route.current.name === "session",
      run: async () => {
        const route = api.route.current
        if (route.name !== "session") return
        const sourceID = route.params?.sessionID
        if (typeof sourceID !== "string") return
        const answer = await askTitle(api)
        if (answer.cancelled) return
        api.ui.toast({ title: "Session archiver", message: "Creating compact replacement...", duration: 3000 })
        let prepared: PreparedArchive
        try {
          prepared = await prepareArchive(api.client, sourceID, answer.title)
          api.route.navigate("session", { sessionID: prepared.target.id })
          if (api.route.current.name !== "session" || api.route.current.params?.sessionID !== prepared.target.id) {
            throw new Error("OpenCode did not switch to the replacement session")
          }
        } catch (error) {
          api.ui.toast({ variant: "error", title: "Session archiver", message: error instanceof Error ? error.message : String(error), duration: 8000 })
          return
        }
        if (!(await confirm(api, prepared))) {
          api.ui.toast({ variant: "info", title: "Session archiver", message: "Original session was kept.", duration: 4000 })
          return
        }
        try {
          await deletePreparedArchive(api.client, prepared)
          api.ui.toast({ variant: "success", title: "Session archived", message: "The compact replacement is now active.", duration: 5000 })
        } catch (error) {
          api.ui.toast({ variant: "error", title: "Deletion incomplete", message: error instanceof Error ? error.message : String(error), duration: 10000 })
        }
      },
    }],
  })
}

export default { id: "evgenyzh.session-archiver", tui } satisfies TuiPluginModule
