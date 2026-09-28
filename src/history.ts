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
  boundarySeq: number
  events: number
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
  keepMessageIDs: string[],
): HistoryPurge | undefined {
  if (keepMessageIDs.length === 0) return undefined
  const matches = keepMessageIDs.map(() => "instr(data, ?) > 0").join(" OR ")
  const boundary = row<{ boundary: SqlValue }>(
    database,
    `SELECT MIN(seq) AS boundary FROM event WHERE aggregate_id = ? AND (${matches})`,
    [sessionID, ...keepMessageIDs],
  )?.boundary
  if (typeof boundary !== "number") return undefined
  const stats = row<{ events: SqlValue; bytes: SqlValue }>(
    database,
    "SELECT COUNT(*) AS events, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM event WHERE aggregate_id = ? AND seq < ?",
    [sessionID, boundary],
  )
  return {
    sessionID,
    boundarySeq: boundary,
    events: typeof stats?.events === "number" ? stats.events : 0,
    bytes: typeof stats?.bytes === "number" ? stats.bytes : 0,
  }
}

export function purgeHistory(database: SqliteDatabase, purge: HistoryPurge): void {
  if (purge.events === 0) return
  database.run(
    "DELETE FROM event WHERE aggregate_id = ? AND seq < ?",
    purge.sessionID,
    purge.boundarySeq,
  )
}

export function checkpoint(database: SqliteDatabase): void {
  database.exec("PRAGMA wal_checkpoint(PASSIVE)")
}
