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
      type TEXT NOT NULL CHECK(type IN ('carmine', 'xp', 'event')),
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
      urgent_message_id TEXT,
      urgent_escalated_at INTEGER,
      urgent_pinged_at INTEGER,
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
      reason TEXT,
      removed_at INTEGER,
      removed_by TEXT
    );

    CREATE TABLE IF NOT EXISTS host_strikes (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE REFERENCES live_server_listings(id),
      moderator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      revoked_at INTEGER,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS active_host_strikes
      ON host_strikes(host_id, active);

    CREATE TABLE IF NOT EXISTS host_blacklist (
      user_id TEXT PRIMARY KEY,
      blacklisted_at INTEGER NOT NULL,
      triggering_session_id TEXT,
      moderator_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'strikes',
      removed_at INTEGER,
      removed_by TEXT
    );

    CREATE TABLE IF NOT EXISTS host_cooldowns (
      user_id TEXT PRIMARY KEY,
      listing_id TEXT,
      successful_creation_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS host_status_strikes (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      revoked_at INTEGER,
      revoked_by TEXT
    );
    CREATE INDEX IF NOT EXISTS active_host_status_strikes
      ON host_status_strikes(host_id, active);

    CREATE TABLE IF NOT EXISTS moderation_status_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      related_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS moderation_status_audit_user
      ON moderation_status_audit(user_id, created_at);
  `);
  migrateReportReasons(db);
  migrateListingTypes(db);
  migrateModerationCasePanels(db);
  migrateModerationStatus(db);
  return db;
}

function migrateListingTypes(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='live_server_listings'")
    .get() as { sql: string } | undefined;
  if (!row?.sql || row.sql.includes("'event'")) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE live_server_listings_event_migration (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('carmine', 'xp', 'event')), url TEXT NOT NULL,
        live_channel_id TEXT NOT NULL, live_message_id TEXT, control_channel_id TEXT NOT NULL,
        control_message_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0, 1)),
        ended_at INTEGER, ended_reason TEXT, updated_at INTEGER NOT NULL
      );
      INSERT INTO live_server_listings_event_migration SELECT * FROM live_server_listings;
      DROP TABLE live_server_listings;
      ALTER TABLE live_server_listings_event_migration RENAME TO live_server_listings;
      CREATE UNIQUE INDEX one_active_listing_per_owner_type
        ON live_server_listings(guild_id, owner_id, type) WHERE active = 1;
      CREATE INDEX active_expirations ON live_server_listings(active, expires_at);
      CREATE INDEX pending_cleanup ON live_server_listings(cleanup_pending);
    `);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  columns: Set<string>,
  name: string,
  definition: string
): void {
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function migrateModerationStatus(db: Database.Database): void {
  const strikeColumns = new Set(
    (db.prepare("PRAGMA table_info(host_strikes)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  addColumnIfMissing(db, "host_strikes", strikeColumns, "revoked_at", "INTEGER");
  addColumnIfMissing(db, "host_strikes", strikeColumns, "revoked_by", "TEXT");

  const hostBlacklistColumns = new Set(
    (db.prepare("PRAGMA table_info(host_blacklist)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  addColumnIfMissing(db, "host_blacklist", hostBlacklistColumns, "source", "TEXT NOT NULL DEFAULT 'strikes'");
  addColumnIfMissing(db, "host_blacklist", hostBlacklistColumns, "removed_at", "INTEGER");
  addColumnIfMissing(db, "host_blacklist", hostBlacklistColumns, "removed_by", "TEXT");

  const reporterBlacklistColumns = new Set(
    (db.prepare("PRAGMA table_info(reporter_blacklist)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  addColumnIfMissing(db, "reporter_blacklist", reporterBlacklistColumns, "removed_at", "INTEGER");
  addColumnIfMissing(db, "reporter_blacklist", reporterBlacklistColumns, "removed_by", "TEXT");

  makeModerationForeignKeysOptional(db);
  removeLegacyAuditActionConstraint(db);
}

function makeModerationForeignKeysOptional(db: Database.Database): void {
  const hostBlacklistColumns = db.prepare("PRAGMA table_info(host_blacklist)").all() as Array<{ name: string; notnull: number }>;
  if (hostBlacklistColumns.find((column) => column.name === "triggering_session_id")?.notnull === 1) {
    db.exec(`
      CREATE TABLE host_blacklist_migrated (
        user_id TEXT PRIMARY KEY, blacklisted_at INTEGER NOT NULL,
        triggering_session_id TEXT, moderator_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'strikes', removed_at INTEGER, removed_by TEXT
      );
      INSERT INTO host_blacklist_migrated SELECT user_id,blacklisted_at,triggering_session_id,
        moderator_id,source,removed_at,removed_by FROM host_blacklist;
      DROP TABLE host_blacklist;
      ALTER TABLE host_blacklist_migrated RENAME TO host_blacklist;
    `);
  }

  const cooldownColumns = db.prepare("PRAGMA table_info(host_cooldowns)").all() as Array<{ name: string; notnull: number }>;
  if (cooldownColumns.find((column) => column.name === "listing_id")?.notnull === 1) {
    db.exec(`
      CREATE TABLE host_cooldowns_migrated (
        user_id TEXT PRIMARY KEY, listing_id TEXT,
        successful_creation_at INTEGER NOT NULL
      );
      INSERT INTO host_cooldowns_migrated SELECT user_id,listing_id,successful_creation_at FROM host_cooldowns;
      DROP TABLE host_cooldowns;
      ALTER TABLE host_cooldowns_migrated RENAME TO host_cooldowns;
    `);
  }
}

function removeLegacyAuditActionConstraint(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='moderation_status_audit'")
    .get() as { sql: string } | undefined;
  if (!row?.sql.includes("CHECK(action IN")) return;
  db.exec(`
    CREATE TABLE moderation_status_audit_migrated (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL,
      moderator_id TEXT NOT NULL, related_id TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO moderation_status_audit_migrated SELECT * FROM moderation_status_audit;
    DROP TABLE moderation_status_audit;
    ALTER TABLE moderation_status_audit_migrated RENAME TO moderation_status_audit;
    CREATE INDEX moderation_status_audit_user ON moderation_status_audit(user_id, created_at);
  `);
}

function migrateReportReasons(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(live_server_reports)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  if (!columns.has("report_reason")) db.exec("ALTER TABLE live_server_reports ADD COLUMN report_reason TEXT");
  if (!columns.has("additional_details")) db.exec("ALTER TABLE live_server_reports ADD COLUMN additional_details TEXT");
}

function migrateModerationCasePanels(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(moderation_cases)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  const legacySchema = !columns.has("urgent_message_id")
    || !columns.has("urgent_escalated_at")
    || !columns.has("urgent_pinged_at");
  if (!columns.has("urgent_message_id")) db.exec("ALTER TABLE moderation_cases ADD COLUMN urgent_message_id TEXT");
  if (!columns.has("urgent_escalated_at")) db.exec("ALTER TABLE moderation_cases ADD COLUMN urgent_escalated_at INTEGER");
  if (!columns.has("urgent_pinged_at")) db.exec("ALTER TABLE moderation_cases ADD COLUMN urgent_pinged_at INTEGER");

  // Cases created by older versions only existed at the seven-report threshold
  // and already pinged moderators. Preserve that fact so reconciliation cannot
  // repeat the role ping after an upgrade.
  if (legacySchema) {
    db.exec(`UPDATE moderation_cases
      SET urgent_escalated_at = COALESCE(urgent_escalated_at, escalated_at),
          urgent_pinged_at = COALESCE(urgent_pinged_at, escalated_at)
      WHERE (SELECT COUNT(*) FROM live_server_reports WHERE session_id = moderation_cases.session_id) >= 7`);
  }
}
