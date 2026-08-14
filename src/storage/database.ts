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

    CREATE TABLE IF NOT EXISTS live_server_reports (
      session_id TEXT NOT NULL REFERENCES live_server_listings(id),
      reporter_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      reported_at INTEGER NOT NULL,
      report_reason TEXT,
      additional_details TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending', 'valid', 'rejected')),
      decided_at INTEGER,
      PRIMARY KEY(session_id, reporter_id)
    );
    CREATE INDEX IF NOT EXISTS reports_by_reporter
      ON live_server_reports(reporter_id, outcome);

    CREATE TABLE IF NOT EXISTS moderation_cases (
      session_id TEXT PRIMARY KEY REFERENCES live_server_listings(id),
      staff_channel_id TEXT NOT NULL,
      staff_message_id TEXT,
      escalated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'ignored', 'struck')),
      resolved_by TEXT,
      resolved_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS moderation_cases_status
      ON moderation_cases(status, staff_message_id);

    CREATE TABLE IF NOT EXISTS reporter_blacklist (
      user_id TEXT PRIMARY KEY,
      blacklisted_at INTEGER NOT NULL,
      moderator_id TEXT NOT NULL,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS host_strikes (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE REFERENCES live_server_listings(id),
      moderator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS active_host_strikes
      ON host_strikes(host_id, active);

    CREATE TABLE IF NOT EXISTS host_blacklist (
      user_id TEXT PRIMARY KEY,
      blacklisted_at INTEGER NOT NULL,
      triggering_session_id TEXT NOT NULL REFERENCES live_server_listings(id),
      moderator_id TEXT NOT NULL
    );
  `);
  migrateReportReasons(db);
  return db;
}

function migrateReportReasons(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(live_server_reports)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  if (!columns.has("report_reason")) db.exec("ALTER TABLE live_server_reports ADD COLUMN report_reason TEXT");
  if (!columns.has("additional_details")) db.exec("ALTER TABLE live_server_reports ADD COLUMN additional_details TEXT");
}
