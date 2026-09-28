import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  prepareHistoryPurge,
  purgeHistory,
  resolveDatabasePath,
  type SqlValue,
  type SqliteDatabase,
} from "../src/history.js"

function sqlite(): SqliteDatabase {
  const database = new DatabaseSync(":memory:")
  database.exec(`
    CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
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

function seed(database: SqliteDatabase, aggregateID: string, events: Array<[number, string]>) {
  database.run("INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, NULL)", aggregateID, events.length - 1)
  for (const [seq, data] of events) {
    database.run("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, 'test', ?)", `evt_${aggregateID}_${seq}`, aggregateID, seq, data)
  }
}

function seqs(database: SqliteDatabase, aggregateID: string): number[] {
  return database
    .query("SELECT seq FROM event WHERE aggregate_id = ? ORDER BY seq")
    .all(aggregateID)
    .map((entry) => entry.seq as number)
}

describe("history purge", () => {
  it("finds the first event of the kept messages and purges only earlier history", () => {
    const database = sqlite()
    seed(database, "ses_1", [
      [0, JSON.stringify({ sessionID: "ses_1" })],
      [1, JSON.stringify({ info: { id: "msg_old" } })],
      [2, JSON.stringify({ messageID: "msg_old", text: "x".repeat(100) })],
      [3, JSON.stringify({ info: { id: "msg_compact" } })],
      [4, JSON.stringify({ info: { id: "msg_summary" } })],
      [5, JSON.stringify({ sessionID: "ses_1", messageID: "msg_old" })],
    ])

    const purge = prepareHistoryPurge(database, "ses_1", ["msg_compact", "msg_summary"])
    expect(purge).toMatchObject({ sessionID: "ses_1", boundarySeq: 3, events: 3 })
    expect(purge?.bytes).toBeGreaterThan(100)

    purgeHistory(database, purge!)
    expect(seqs(database, "ses_1")).toEqual([3, 4, 5])

    const again = prepareHistoryPurge(database, "ses_1", ["msg_compact", "msg_summary"])
    expect(again).toMatchObject({ boundarySeq: 3, events: 0, bytes: 0 })
  })

  it("leaves other aggregates alone", () => {
    const database = sqlite()
    seed(database, "ses_1", [
      [0, JSON.stringify({ info: { id: "msg_old" } })],
      [1, JSON.stringify({ info: { id: "msg_keep" } })],
    ])
    seed(database, "ses_2", [
      [0, JSON.stringify({ info: { id: "msg_other" } })],
    ])

    purgeHistory(database, prepareHistoryPurge(database, "ses_1", ["msg_keep"])!)
    expect(seqs(database, "ses_1")).toEqual([1])
    expect(seqs(database, "ses_2")).toEqual([0])
  })

  it("skips sessions without events for the kept messages", () => {
    const database = sqlite()
    seed(database, "ses_1", [[0, JSON.stringify({ info: { id: "msg_old" } })]])
    expect(prepareHistoryPurge(database, "ses_1", ["msg_keep"])).toBeUndefined()
    expect(prepareHistoryPurge(database, "ses_1", [])).toBeUndefined()
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
})
