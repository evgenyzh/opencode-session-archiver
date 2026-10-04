import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  openLocalDatabase,
  prepareHistoryPurge,
  purgeHistory,
  resolveDatabasePath,
  type SqlValue,
  type SqliteDatabase,
} from "../src/history.js"

function sqlite(): SqliteDatabase {
  const database = new DatabaseSync(":memory:")
  database.exec(`
    CREATE TABLE session_message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      seq integer NOT NULL,
      type text NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE event (
      id text PRIMARY KEY,
      aggregate_id text NOT NULL,
      seq integer NOT NULL,
      type text NOT NULL,
      data text NOT NULL
    );
  `)
  return {
    query: (sql) => ({
      all: (...params: SqlValue[]) =>
        database.prepare(sql).all(...(params as SQLInputValue[])) as Array<Record<string, SqlValue>>,
    }),
    run: (sql, ...params) => database.prepare(sql).run(...(params as SQLInputValue[])),
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
  }
}

function seedMessages(database: SqliteDatabase, sessionID: string, entries: Array<[number, string, string]>) {
  for (const [seq, id, data] of entries) {
    database.run(
      "INSERT INTO session_message (id, session_id, seq, type, data) VALUES (?, ?, ?, 'assistant', ?)",
      id,
      sessionID,
      seq,
      data,
    )
  }
}

function seedLegacy(database: SqliteDatabase, sessionID: string, messageID: string) {
  database.run("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)", messageID, sessionID, "legacy message")
  database.run(
    "INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)",
    `part_${messageID}`,
    messageID,
    sessionID,
    "legacy part",
  )
}

function seedEvents(database: SqliteDatabase, aggregateID: string, entries: Array<[number, string]>) {
  for (const [seq, data] of entries) {
    database.run(
      "INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, 'test', ?)",
      `evt_${aggregateID}_${seq}`,
      aggregateID,
      seq,
      data,
    )
  }
}

function seqs(database: SqliteDatabase, sessionID: string): number[] {
  return database
    .query("SELECT seq FROM session_message WHERE session_id = ? ORDER BY seq")
    .all(sessionID)
    .map((entry) => entry.seq as number)
}

function eventSeqs(database: SqliteDatabase, aggregateID: string): number[] {
  return database
    .query("SELECT seq FROM event WHERE aggregate_id = ? ORDER BY seq")
    .all(aggregateID)
    .map((entry) => entry.seq as number)
}

describe("history purge", () => {
  it("keeps the compaction message and purges older messages, legacy rows, and events", () => {
    const database = sqlite()
    seedMessages(database, "ses_1", [
      [0, "msg_old", "x".repeat(200)],
      [1, "msg_compact", JSON.stringify({ summary: "kept" })],
      [2, "msg_after", "y".repeat(50)],
    ])
    seedLegacy(database, "ses_1", "legacy_1")
    seedEvents(database, "ses_1", [
      [0, JSON.stringify({ messageID: "msg_old" })],
      [1, JSON.stringify({ messageID: "msg_compact" })],
      [2, JSON.stringify({ messageID: "msg_after" })],
    ])

    const purge = prepareHistoryPurge(database, "ses_1", "msg_compact")
    expect(purge).toMatchObject({
      sessionID: "ses_1",
      compactionID: "msg_compact",
      boundarySeq: 1,
      messages: 2,
      events: 1,
      eventBoundarySeq: 1,
      legacyMessages: 1,
      legacyParts: 1,
    })
    expect(purge?.bytes).toBeGreaterThan(200)

    purgeHistory(database, purge!)
    expect(seqs(database, "ses_1")).toEqual([1])
    expect(eventSeqs(database, "ses_1")).toEqual([1, 2])
    expect(database.query("SELECT COUNT(*) AS count FROM message WHERE session_id = 'ses_1'").all()[0]?.count).toBe(0)
    expect(database.query("SELECT COUNT(*) AS count FROM part WHERE session_id = 'ses_1'").all()[0]?.count).toBe(0)

    const again = prepareHistoryPurge(database, "ses_1", "msg_compact")
    expect(again).toMatchObject({ messages: 0, events: 0, bytes: 0, legacyMessages: 0, legacyParts: 0 })
  })

  it("leaves other sessions and aggregates alone", () => {
    const database = sqlite()
    seedMessages(database, "ses_1", [
      [0, "msg_old", "old"],
      [1, "msg_keep", "keep"],
    ])
    seedMessages(database, "ses_2", [
      [0, "msg_other", "other"],
      [1, "msg_other_compact", "compact"],
    ])
    seedEvents(database, "ses_2", [[0, JSON.stringify({ messageID: "msg_other_compact" })]])

    purgeHistory(database, prepareHistoryPurge(database, "ses_1", "msg_keep")!)
    expect(seqs(database, "ses_1")).toEqual([1])
    expect(seqs(database, "ses_2")).toEqual([0, 1])
    expect(eventSeqs(database, "ses_2")).toEqual([0])
  })

  it("skips sessions without the compaction message", () => {
    const database = sqlite()
    seedMessages(database, "ses_1", [[0, "msg_old", "old"]])
    expect(prepareHistoryPurge(database, "ses_1", "msg_missing")).toBeUndefined()
    expect(prepareHistoryPurge(database, "ses_1", "")).toBeUndefined()
  })
})

describe("database path", () => {
  it("uses the OpenCode data directory by default", () => {
    expect(resolveDatabasePath({}, "/home/user")).toBe("/home/user/.local/share/opencode/opencode.db")
  })

  it("honours XDG_DATA_HOME", () => {
    expect(resolveDatabasePath({ XDG_DATA_HOME: "/data" }, "/home/user")).toBe("/data/opencode/opencode.db")
  })

  it("honours OPENCODE_DB, absolute and relative", () => {
    expect(resolveDatabasePath({ OPENCODE_DB: "/tmp/custom.db" }, "/home/user")).toBe("/tmp/custom.db")
    expect(resolveDatabasePath({ OPENCODE_DB: "custom.db" }, "/home/user")).toBe("/home/user/.local/share/opencode/custom.db")
    expect(resolveDatabasePath({ OPENCODE_DB: ":memory:" }, "/home/user")).toBeUndefined()
  })

  it("reports a reason when the database file is missing", async () => {
    const result = await openLocalDatabase("/nonexistent/opencode.db")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("not found")
  })
})
