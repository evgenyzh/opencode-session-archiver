import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { prepareArchive, removeArchiveChildren, verifyArchive, type PreparedArchive } from "./archive.js"
import {
  checkpoint,
  openLocalDatabase,
  prepareHistoryPurge,
  purgeHistory,
  resolveDatabasePath,
  type HistoryPurge,
  type SqliteDatabase,
} from "./history.js"

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function openArchiveDatabase(): Promise<{ database: SqliteDatabase } | { error: string }> {
  const path = resolveDatabasePath()
  if (!path) return { error: "OPENCODE_DB points to :memory:, so there is no database file to prune." }
  const result = await openLocalDatabase(path)
  if (!result.ok) {
    console.warn("[session-archiver] local database unavailable", { path, reason: result.reason })
    return { error: `${result.reason} (${path})` }
  }
  return { database: result.database }
}

async function confirm(context: Context, prepared: PreparedArchive, purge: HistoryPurge): Promise<boolean> {
  const message = [
    `Keep the compaction summary of "${prepared.source.title ?? prepared.sourceID}".`,
    `Delete ${prepared.deleteMessageIDs.length} message(s).`,
    prepared.agentChildIDs.length > 0 ? `Delete ${prepared.agentChildIDs.length} subagent session(s).` : "",
    prepared.orphanChildIDs.length > 0 ? `Delete ${prepared.orphanChildIDs.length} orphaned subagent session(s) (no task evidence).` : "",
    purge.bytes > 0 ? `Purge ${humanBytes(purge.bytes)} of pre-compaction history from the local database.` : "",
    "This cannot be undone.",
  ].filter(Boolean).join("\n")
  return (await context.ui.dialog.confirm({ title: "Archive session?", message })) === true
}

export default Plugin.define({
  id: "evgenyzh.session-archiver",
  setup(context) {
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "session-archiver.archive",
            title: "Archive current session",
            description: "Keep only the compaction summary, purge its history, and delete subagent children after confirmation",
            group: "Session",
            slash: { name: "archive-session" },
            enabled: () => context.ui.router.current().type === "session",
            run: async () => {
              const route = context.ui.router.current()
              if (route.type !== "session") return
              const sourceID = route.sessionID

              const opened = await openArchiveDatabase()
              if ("error" in opened) {
                context.ui.toast.show({
                  variant: "error",
                  title: "Session archiver",
                  message: `Local OpenCode database unavailable: ${opened.error}`,
                  duration: 10000,
                })
                return
              }
              const database = opened.database

              try {
                context.ui.toast.show({ title: "Session archiver", message: "Preparing archive...", duration: 3000 })

                const prepared = await prepareArchive(context.client, sourceID)

                let purge: HistoryPurge | undefined
                try {
                  purge = prepareHistoryPurge(database, sourceID, prepared.keepMessageIDs[0] ?? "")
                } catch (error) {
                  context.ui.toast.show({
                    variant: "error",
                    title: "Session archiver",
                    message: `Could not inspect local history: ${describe(error)}`,
                    duration: 8000,
                  })
                  return
                }
                if (!purge) {
                  context.ui.toast.show({
                    variant: "error",
                    title: "Session archiver",
                    message: "The local database has no messages for this session.",
                    duration: 8000,
                  })
                  return
                }

                if (!(await confirm(context, prepared, purge))) {
                  context.ui.toast.show({
                    variant: "info",
                    title: "Session archiver",
                    message: "Nothing was deleted; the compaction created by this run remains.",
                    duration: 5000,
                  })
                  return
                }
                purgeHistory(database, purge)
                await removeArchiveChildren(context.client, prepared)
                await verifyArchive(context.client, prepared)
                checkpoint(database)
                context.data.session.message.invalidate(sourceID)
                context.data.session.invalidate(sourceID)
                context.ui.toast.show({
                  variant: "success",
                  title: "Session archived",
                  message: purge.bytes > 0
                    ? `Only the compaction summary remains; ${humanBytes(purge.bytes)} of history purged.`
                    : "Only the compaction summary remains.",
                  duration: 5000,
                })
              } catch (error) {
                context.ui.toast.show({ variant: "error", title: "Archive failed", message: describe(error), duration: 10000 })
              } finally {
                database.close()
              }
            },
          }],
        }))
        return null
      },
    })
  },
})
