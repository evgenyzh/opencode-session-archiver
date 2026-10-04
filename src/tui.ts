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

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function openArchiveDatabase(): Promise<SqliteDatabase | undefined> {
  const path = resolveDatabasePath()
  if (!path) return undefined
  const database = await openLocalDatabase(path)
  if (!database) console.warn("[session-archiver] local database unavailable", { path })
  return database
}

async function confirm(context: Context, prepared: PreparedArchive, purge: HistoryPurge): Promise<boolean> {
  const message = [
    `Keep the compaction summary of "${prepared.source.title ?? prepared.sourceID}".`,
    `Delete ${prepared.deleteMessageIDs.length} message(s).`,
    prepared.agentChildIDs.length > 0 ? `Delete ${prepared.agentChildIDs.length} subagent session(s).` : "",
    prepared.orphanChildIDs.length > 0 ? `Delete ${prepared.orphanChildIDs.length} orphaned subagent session(s) (no task evidence).` : "",
    purge.bytes > 0 ? `Purge ${megabytes(purge.bytes)} of pre-compaction history from the local database.` : "",
    "This cannot be undone.",
  ].filter(Boolean).join("\n")
  return (await context.ui.dialog.confirm({ title: "Archive session?", message })) === true
}

export default Plugin.define({
  id: "evgenyzh.session-archiver",
  setup(context) {
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
          context.ui.toast.show({ title: "Session archiver", message: "Preparing archive...", duration: 3000 })

          let prepared: PreparedArchive
          try {
            prepared = await prepareArchive(context.client, sourceID)
          } catch (error) {
            context.ui.toast.show({ variant: "error", title: "Session archiver", message: describe(error), duration: 8000 })
            return
          }

          const database = await openArchiveDatabase()
          if (!database) {
            context.ui.toast.show({
              variant: "error",
              title: "Session archiver",
              message: "Local OpenCode database unavailable; messages cannot be pruned.",
              duration: 8000,
            })
            return
          }

          let purge: HistoryPurge | undefined
          try {
            purge = prepareHistoryPurge(database, sourceID, prepared.keepMessageIDs[0] ?? "")
          } catch (error) {
            database.close()
            context.ui.toast.show({
              variant: "error",
              title: "Session archiver",
              message: `Could not inspect local history: ${describe(error)}`,
              duration: 8000,
            })
            return
          }
          if (!purge) {
            database.close()
            context.ui.toast.show({
              variant: "error",
              title: "Session archiver",
              message: "The local database has no messages for this session.",
              duration: 8000,
            })
            return
          }

          try {
            if (!(await confirm(context, prepared, purge))) {
              context.ui.toast.show({ variant: "info", title: "Session archiver", message: "Session was kept unchanged.", duration: 4000 })
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
                ? `Only the compaction summary remains; ${megabytes(purge.bytes)} of history purged.`
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
  },
})
