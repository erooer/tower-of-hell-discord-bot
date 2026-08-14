import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openDatabase(path: string): Database.Database {
  const resolved = path === ":memory:" ? path : resolve(path);
  if (resolved !== ":memory:") mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_server_listings (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('carmine', 'xp')),
      url TEXT NOT NULL,
      live_channel_id TEXT NOT NULL,
      live_message_id TEXT,
      control_channel_id TEXT NOT NULL,
      control_message_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0, 1)),
      ended_at INTEGER,
      ended_reason TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_listing_per_owner_type
      ON live_server_listings(guild_id, owner_id, type) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS active_expirations
      ON live_server_listings(active, expires_at);
    CREATE INDEX IF NOT EXISTS pending_cleanup
      ON live_server_listings(cleanup_pending);
  `);
  return db;
}
