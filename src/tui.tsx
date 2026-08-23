/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { deletePreparedArchive, prepareArchive, type PreparedArchive } from "./archive.js"

function confirm(api: Parameters<TuiPluginModule["tui"]>[0], prepared: PreparedArchive): Promise<boolean> {
  return new Promise((resolve) => {
    const Confirm = api.ui.DialogConfirm
    const message = [
      `Keep the compaction summary of "${prepared.source.title}".`,
      `Delete ${prepared.deleteMessageIDs.length} message(s).`,
      prepared.agentChildIDs.length > 0 ? `Delete ${prepared.agentChildIDs.length} subagent session(s).` : "",
      "This cannot be undone.",
    ].filter(Boolean).join("\n")
    api.ui.dialog.replace(
      () => <Confirm title="Archive session?" message={message} onConfirm={() => resolve(true)} onCancel={() => resolve(false)} />,
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
      desc: "Keep only the compaction summary and delete subagent children after confirmation",
      category: "Session",
      slashName: "archive-session",
      enabled: () => api.route.current.name === "session",
      run: async () => {
        const route = api.route.current
        if (route.name !== "session") return
        const sourceID = route.params?.sessionID
        if (typeof sourceID !== "string") return
        api.ui.toast({ title: "Session archiver", message: "Preparing archive...", duration: 3000 })
        let prepared: PreparedArchive
        try {
          prepared = await prepareArchive(api.client, sourceID)
        } catch (error) {
          api.ui.toast({ variant: "error", title: "Session archiver", message: error instanceof Error ? error.message : String(error), duration: 8000 })
          return
        }
        if (!(await confirm(api, prepared))) {
          api.ui.toast({ variant: "info", title: "Session archiver", message: "Session was kept unchanged.", duration: 4000 })
          return
        }
        try {
          await deletePreparedArchive(api.client, prepared)
          api.ui.toast({ variant: "success", title: "Session archived", message: "Only the compaction summary remains.", duration: 5000 })
        } catch (error) {
          api.ui.toast({ variant: "error", title: "Deletion incomplete", message: error instanceof Error ? error.message : String(error), duration: 10000 })
        }
      },
    }],
  })
}

export default { id: "evgenyzh.session-archiver", tui } satisfies TuiPluginModule
