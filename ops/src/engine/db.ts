import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface TaskState {
  id: string;
  next_run: number;
  last_run: number;
  last_ok: number;
  failures: number;
  paused: number;
  last_result: string;
}

/** Small persistence layer: task schedule state, key/value memory, event log. */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS task (
        id TEXT PRIMARY KEY,
        next_run INTEGER NOT NULL DEFAULT 0,
        last_run INTEGER NOT NULL DEFAULT 0,
        last_ok INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        last_result TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_at ON event(at);
    `);
  }

  task(id: string): TaskState {
    this.db.prepare("INSERT OR IGNORE INTO task (id) VALUES (?)").run(id);
    return this.db.prepare("SELECT * FROM task WHERE id = ?").get(id) as unknown as TaskState;
  }

  tasks(): TaskState[] {
    return this.db.prepare("SELECT * FROM task ORDER BY id").all() as unknown as TaskState[];
  }

  saveTask(t: TaskState) {
    this.db
      .prepare("UPDATE task SET next_run=?, last_run=?, last_ok=?, failures=?, paused=?, last_result=? WHERE id=?")
      .run(t.next_run, t.last_run, t.last_ok, t.failures, t.paused, t.last_result.slice(0, 2000), t.id);
  }

  get<T>(k: string): T | undefined {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  set(k: string, v: unknown) {
    this.db
      .prepare("INSERT INTO kv (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated=excluded.updated")
      .run(k, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)), Date.now());
  }

  log(kind: string, subject: string, detail: string) {
    this.db.prepare("INSERT INTO event (at, kind, subject, detail) VALUES (?, ?, ?, ?)").run(Date.now(), kind, subject, detail.slice(0, 4000));
  }

  recent(limit = 20, kind?: string) {
    const q = kind
      ? this.db.prepare("SELECT * FROM event WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit)
      : this.db.prepare("SELECT * FROM event ORDER BY id DESC LIMIT ?").all(limit);
    return q as unknown as { id: number; at: number; kind: string; subject: string; detail: string }[];
  }
}
