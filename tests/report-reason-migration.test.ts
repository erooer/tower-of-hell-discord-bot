import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { ModerationRepository } from "../src/storage/moderation-repository.js";

describe("report reason migration", () => {
  it("adds nullable reason columns without losing legacy reports", () => {
    const directory = mkdtempSync(join(tmpdir(), "report-reason-migration-"));
    const path = join(directory, "legacy.sqlite");
    try {
      const legacy = new BetterSqlite3(path);
      legacy.exec(`
        CREATE TABLE live_server_listings (
          id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL,
          type TEXT NOT NULL, url TEXT NOT NULL, live_channel_id TEXT NOT NULL,
          live_message_id TEXT, control_channel_id TEXT NOT NULL, control_message_id TEXT,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, active INTEGER NOT NULL,
          cleanup_pending INTEGER NOT NULL, ended_at INTEGER, ended_reason TEXT, updated_at INTEGER NOT NULL
        );
        CREATE TABLE live_server_reports (
          session_id TEXT NOT NULL, reporter_id TEXT NOT NULL, host_id TEXT NOT NULL,
          reported_at INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', decided_at INTEGER,
          PRIMARY KEY(session_id, reporter_id)
        );
        INSERT INTO live_server_listings VALUES
          ('legacy-session','guild','host','xp','https://www.roblox.com/share?code=LegacyCode123&type=Server',
           'live','message','commands','control',1800000000000,1800007200000,1,0,NULL,NULL,1800000000000);
        INSERT INTO live_server_reports VALUES
          ('legacy-session','legacy-reporter','host',1800000001000,'pending',NULL);
      `);
      legacy.close();

      const migrated = openDatabase(path);
      const columns = (migrated.prepare("PRAGMA table_info(live_server_reports)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toContain("report_reason");
      expect(columns).toContain("additional_details");
      const repository = new ModerationRepository(migrated);
      expect(repository.getReporterSummaries("legacy-session")).toContainEqual(expect.objectContaining({
        userId: "legacy-reporter", reason: null, details: null, total: 1
      }));
      expect(repository.getReasonCounts("legacy-session")).toEqual([{ reason: null, count: 1 }]);
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
