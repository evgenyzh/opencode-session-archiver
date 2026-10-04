import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export type SqlValue = string | number | null

export type SqlStatement = {
  all(...params: SqlValue[]): Array<Record<string, SqlValue>>
}

export type SqliteDatabase = {
  query(sql: string): SqlStatement
  run(sql: string, ...params: SqlValue[]): unknown
  exec(sql: string): void
  close(): void
}

export type HistoryPurge = {
  sessionID: string
  compactionID: string
  boundarySeq: number
  messages: number
  messageBytes: number
  events: number
  eventBytes: number
  eventBoundarySeq: number | null
  legacyMessages: number
  legacyParts: number
  bytes: number
}

type BunDatabase = SqliteDatabase

export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  const dataDir =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? join(env.XDG_DATA_HOME, "opencode")
      : join(home, ".local", "share", "opencode")
  const configured = env.OPENCODE_DB
  if (configured === ":memory:") return undefined
  if (configured) return isAbsolute(configured) ? configured : join(dataDir, configured)
  return join(dataDir, "opencode.db")
}

export async function openLocalDatabase(path: string): Promise<SqliteDatabase | undefined> {
  if (!existsSync(path)) return undefined
  try {
    const specifier = "bun:sqlite"
    const module = (await import(specifier)) as {
      Database: new (filename: string, options?: { create?: boolean; readwrite?: boolean }) => BunDatabase
    }
    const database = new module.Database(path, { create: false })
    database.exec("PRAGMA busy_timeout = 5000")
    database.exec("PRAGMA foreign_keys = ON")
    return database
  } catch {
    return undefined
  }
}

function row<T extends Record<string, SqlValue>>(database: SqliteDatabase, sql: string, params: SqlValue[]): T | undefined {
  return database.query(sql).all(...params)[0] as T | undefined
}

export function prepareHistoryPurge(
  database: SqliteDatabase,
  sessionID: string,
  compactionID: string,
): HistoryPurge | undefined {
  const boundary = row<{ boundary: SqlValue }>(
    database,
    "SELECT seq AS boundary FROM session_message WHERE session_id = ? AND id = ?",
    [sessionID, compactionID],
  )?.boundary
  if (typeof boundary !== "number") return undefined

  const messages = row<{ messages: SqlValue; bytes: SqlValue }>(
    database,
    "SELECT COUNT(*) AS messages, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM session_message WHERE session_id = ? AND id != ?",
    [sessionID, compactionID],
  )
  const eventBoundary = row<{ boundary: SqlValue }>(
    database,
    "SELECT MIN(seq) AS boundary FROM event WHERE aggregate_id = ? AND instr(data, ?) > 0",
    [sessionID, compactionID],
  )?.boundary
  const events =
    typeof eventBoundary === "number"
      ? row<{ events: SqlValue; bytes: SqlValue }>(
          database,
          "SELECT COUNT(*) AS events, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM event WHERE aggregate_id = ? AND seq < ?",
          [sessionID, eventBoundary],
        )
      : undefined
  const legacyMessages = row<{ count: SqlValue }>(
    database,
    "SELECT COUNT(*) AS count FROM message WHERE session_id = ?",
    [sessionID],
  )?.count
  const legacyParts = row<{ count: SqlValue }>(
    database,
    "SELECT COUNT(*) AS count FROM part WHERE session_id = ?",
    [sessionID],
  )?.count

  const messageBytes = typeof messages?.bytes === "number" ? messages.bytes : 0
  const eventBytes = typeof events?.bytes === "number" ? events.bytes : 0
  return {
    sessionID,
    compactionID,
    boundarySeq: boundary,
    messages: typeof messages?.messages === "number" ? messages.messages : 0,
    messageBytes,
    events: typeof events?.events === "number" ? events.events : 0,
    eventBytes,
    eventBoundarySeq: typeof eventBoundary === "number" ? eventBoundary : null,
    legacyMessages: typeof legacyMessages === "number" ? legacyMessages : 0,
    legacyParts: typeof legacyParts === "number" ? legacyParts : 0,
    bytes: messageBytes + eventBytes,
  }
}

export function purgeHistory(database: SqliteDatabase, purge: HistoryPurge): void {
  database.exec("BEGIN")
  try {
    database.run("DELETE FROM session_message WHERE session_id = ? AND id != ?", purge.sessionID, purge.compactionID)
    database.run("DELETE FROM part WHERE session_id = ?", purge.sessionID)
    database.run("DELETE FROM message WHERE session_id = ?", purge.sessionID)
    if (purge.eventBoundarySeq !== null && purge.events > 0) {
      database.run("DELETE FROM event WHERE aggregate_id = ? AND seq < ?", purge.sessionID, purge.eventBoundarySeq)
    }
    database.exec("COMMIT")
  } catch (error) {
    try {
      database.exec("ROLLBACK")
    } catch {
      // The transaction is already closed; surface the original failure.
    }
    throw error
  }
}

export function checkpoint(database: SqliteDatabase): void {
  database.exec("PRAGMA wal_checkpoint(PASSIVE)")
}
