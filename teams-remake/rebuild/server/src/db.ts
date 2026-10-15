// Storage layer. Mirrors the Teams chat-service model observed in the client
// (see ../../notes.md §4): threads have members + properties, users see threads as
// conversations, messages live in threads, users are identified by MRI.
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.TEAMS_DATA_DIR ?? "data");
mkdirSync(path.join(DATA_DIR, "files"), { recursive: true });

export const db = new DatabaseSync(process.env.TEAMS_DB ?? path.join(DATA_DIR, "teams.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  mri TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  presence_override TEXT,
  created_at INTEGER NOT NULL
);
-- type: chat | team | channel
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  topic TEXT,
  description TEXT,
  team_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
  is_general INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  mri TEXT NOT NULL REFERENCES users(mri),
  role TEXT NOT NULL DEFAULT 'User',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, mri)
);
-- consumption horizon = last-read timestamp per user per thread (chat or channel)
CREATE TABLE IF NOT EXISTS horizons (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  mri TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, mri)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id TEXT,
  from_mri TEXT,
  message_type TEXT NOT NULL,
  subject TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS messages_parent ON messages(parent_id, created_at);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mri TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, mri, emoji)
);
CREATE TABLE IF NOT EXISTS mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mri TEXT NOT NULL,
  PRIMARY KEY (message_id, mri)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_mri TEXT NOT NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- activity feed (the "notifications" stream in real Teams)
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  mri TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_mri TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  preview TEXT,
  created_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_mri ON activity(mri, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, message_id UNINDEXED, thread_id UNINDEXED);
`);

export const now = () => Date.now();
export const newMri = () => `8:orgid:${randomUUID()}`;
export const newChatId = () => `19:${randomBytes(16).toString("hex")}@thread.v2`;
export const newTeamThreadId = () => `19:${randomBytes(16).toString("hex")}@thread.tacv2`;
export const newId = () => `${Date.now()}${randomBytes(3).readUIntBE(0, 3).toString().padStart(8, "0")}`;

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(pw, salt, 32).toString("hex")}`;
}
export function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const got = scryptSync(pw, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(got, Buffer.from(hash, "hex"));
}

export const htmlToText = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// Typed row helpers
export type Row = Record<string, any>;
export const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
export const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
