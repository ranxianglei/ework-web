// SQLite store. One DB file holds the runtime config table AND the ework schema
// (projects/issues/comments/labels/reactions/attachments/users) so transactions
// span them. Schema is applied on boot via schema.sql.

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

const DB_PATH =
  process.env.WORK_DB_PATH ||
  join(process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`, "ework", "ework.db");

let _db: Database | null = null;

function db(): Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH, { create: true, readwrite: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec(
    "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
  );
  _db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  return _db;
}

export function rawDB(): Database {
  return db();
}

export function getConfigAll(): Record<string, string> {
  try {
    const rows = db().query("SELECT key, value FROM config").all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch {
    return {};
  }
}

export function setConfig(key: string, value: string): void {
  const now = new Date().toISOString();
  db()
    .query(
      "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(key, value, now);
}

export function deleteConfig(key: string): void {
  db().query("DELETE FROM config WHERE key = ?").run(key);
}
