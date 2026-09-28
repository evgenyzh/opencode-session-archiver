/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { deletePreparedArchive, prepareArchive, type PreparedArchive } from "./archive.js"
import {
  checkpoint,
  openLocalDatabase,
  prepareHistoryPurge,
  purgeHistory,
  resolveDatabasePath,
  type HistoryPurge,
  type SqliteDatabase,
} from "./history.js"

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function confirm(api: Parameters<TuiPluginModule["tui"]>[0], prepared: PreparedArchive, purge: HistoryPurge | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const Confirm = api.ui.DialogConfirm
    const message = [
      `Keep the compaction summary of "${prepared.source.title}".`,
      `Delete ${prepared.deleteMessageIDs.length} message(s).`,
      prepared.agentChildIDs.length > 0 ? `Delete ${prepared.agentChildIDs.length} subagent session(s).` : "",
      prepared.orphanChildIDs.length > 0 ? `Delete ${prepared.orphanChildIDs.length} orphaned subagent session(s) (no task evidence).` : "",
      purge && purge.bytes > 0 ? `Purge ${megabytes(purge.bytes)} of pre-compaction history from the local database.` : "",
      "This cannot be undone.",
    ].filter(Boolean).join("\n")
    api.ui.dialog.replace(
      () => <Confirm title="Archive session?" message={message} onConfirm={() => resolve(true)} onCancel={() => resolve(false)} />,
      () => resolve(false),
    )
  })
}

async function openArchiveDatabase(): Promise<SqliteDatabase | undefined> {
  const path = resolveDatabasePath()
  if (!path) return undefined
  const database = await openLocalDatabase(path)
  if (!database) console.warn("[session-archiver] local database unavailable; history will not be purged", { path })
  return database
}

const tui: TuiPluginModule["tui"] = async (api) => {
  api.keymap.registerLayer({
    commands: [{
      namespace: "palette",
      name: "session-archiver.archive",
      title: "Archive current session",
      desc: "Keep only the compaction summary, purge its history, and delete subagent children after confirmation",
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
        const database = await openArchiveDatabase()
        let purge: HistoryPurge | undefined
        if (database) {
          try {
            purge = prepareHistoryPurge(database, sourceID, prepared.keepMessageIDs)
          } catch (error) {
            console.warn("[session-archiver] could not inspect history", error)
          }
        }
        try {
          if (!(await confirm(api, prepared, purge))) {
            api.ui.toast({ variant: "info", title: "Session archiver", message: "Session was kept unchanged.", duration: 4000 })
            return
          }
          try {
            await deletePreparedArchive(api.client, prepared)
          } catch (error) {
            api.ui.toast({ variant: "error", title: "Deletion incomplete", message: error instanceof Error ? error.message : String(error), duration: 10000 })
            return
          }
          let purged = 0
          if (database && purge && purge.bytes > 0) {
            try {
              purgeHistory(database, purge)
              checkpoint(database)
              purged = purge.bytes
            } catch (error) {
              api.ui.toast({
                variant: "warning",
                title: "Session archived",
                message: `History purge failed: ${error instanceof Error ? error.message : String(error)}`,
                duration: 10000,
              })
              return
            }
          }
          api.ui.toast({
            variant: "success",
            title: "Session archived",
            message: purged > 0
              ? `Only the compaction summary remains; ${megabytes(purged)} of history purged.`
              : "Only the compaction summary remains.",
            duration: 5000,
          })
        } finally {
          database?.close()
        }
      },
    }],
  })
}

export default { id: "evgenyzh.session-archiver", tui } satisfies TuiPluginModule
