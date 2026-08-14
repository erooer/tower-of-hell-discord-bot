import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { openDatabase } from "../src/storage/database.js";
import { ListingRepository } from "../src/storage/listing-repository.js";
import { EXTENSION_MS } from "../src/live-servers/model.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ListingRepository", () => {
  let database: Database.Database;
  let repository: ListingRepository;
  const base = 1_800_000_000_000;

  beforeEach(() => {
    database = openDatabase(":memory:");
    repository = new ListingRepository(database);
  });

  afterEach(() => database.close());

  function create(expiresAt = base + 2 * 60 * 60_000) {
    return repository.create({
      guildId: "guild", ownerId: "owner", type: "carmine", url: "https://www.roblox.com/share?code=AbCdEfGh1234&type=Server",
      liveChannelId: "live", liveMessageId: "message", controlChannelId: "controls", controlMessageId: "panel",
      createdAt: base, expiresAt
    });
  }

  it("enforces one active listing per owner and type", () => {
    create();
    expect(() => create()).toThrow(/UNIQUE constraint failed/);
    expect(() => repository.create({
      guildId: "guild", ownerId: "owner", type: "xp", url: "https://www.roblox.com/share?code=AbCdEfGh1234&type=Server",
      liveChannelId: "live", liveMessageId: null, controlChannelId: "controls", controlMessageId: null,
      createdAt: base, expiresAt: base + 1
    })).not.toThrow();
    expect(() => repository.create({
      guildId: "guild", ownerId: "owner", type: "event", url: "https://www.roblox.com/share?code=EventCode123&type=Server",
      liveChannelId: "live", liveMessageId: null, controlChannelId: "controls", controlMessageId: null,
      createdAt: base, expiresAt: base + 1
    })).not.toThrow();
  });

  it("migrates the legacy two-type constraint without losing existing listings", () => {
    database.close();
    const directory = mkdtempSync(join(tmpdir(), "listing-event-migration-"));
    const path = join(directory, "legacy.sqlite");
    try {
      const legacy = new BetterSqlite3(path);
      legacy.exec(`CREATE TABLE live_server_listings (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('carmine','xp')), url TEXT NOT NULL,
        live_channel_id TEXT NOT NULL, live_message_id TEXT, control_channel_id TEXT NOT NULL,
        control_message_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, cleanup_pending INTEGER NOT NULL DEFAULT 0,
        ended_at INTEGER, ended_reason TEXT, updated_at INTEGER NOT NULL
      );
      INSERT INTO live_server_listings VALUES
        ('legacy','guild','legacy-owner','carmine','https://www.roblox.com/share?code=Legacy&type=Server',
        'live','message','controls','panel',${base},${base + 7_200_000},1,0,NULL,NULL,${base});
      CREATE TABLE live_server_reports (
        session_id TEXT NOT NULL REFERENCES live_server_listings(id), reporter_id TEXT NOT NULL,
        host_id TEXT NOT NULL, reported_at INTEGER NOT NULL, report_reason TEXT,
        additional_details TEXT, outcome TEXT NOT NULL DEFAULT 'pending', decided_at INTEGER,
        PRIMARY KEY(session_id, reporter_id)
      );
      INSERT INTO live_server_reports VALUES ('legacy','reporter','legacy-owner',${base},NULL,NULL,'pending',NULL);`);
      legacy.close();

      database = openDatabase(path);
      repository = new ListingRepository(database);
      expect(repository.get("legacy")).toMatchObject({ ownerId: "legacy-owner", type: "carmine", active: true });
      expect((database.prepare("SELECT COUNT(*) AS count FROM live_server_reports WHERE session_id='legacy'").get() as { count: number }).count).toBe(1);
      expect(() => repository.create({
        guildId: "guild", ownerId: "event-owner", type: "event",
        url: "https://www.roblox.com/share?code=Event&type=Server", liveChannelId: "live",
        liveMessageId: "event-message", controlChannelId: "controls", controlMessageId: "event-panel",
        createdAt: base, expiresAt: base + 7_200_000
      })).not.toThrow();
    } finally {
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
      database = openDatabase(":memory:");
      repository = new ListingRepository(database);
    }
  });

  it("blocks early extensions", () => {
    const listing = create();
    expect(repository.extend(listing.id, listing.expiresAt - 10 * 60_000 - 1)).toEqual({ ok: false, reason: "too_early" });
  });

  it("extends exactly one hour from the current expiration and prevents stacking", () => {
    const listing = create();
    const first = repository.extend(listing.id, listing.expiresAt - 5 * 60_000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.listing.expiresAt).toBe(listing.expiresAt + EXTENSION_MS);
    expect(repository.extend(listing.id, listing.expiresAt - 5 * 60_000)).toEqual({ ok: false, reason: "too_early" });
  });

  it("atomically claims expired listings and permits a replacement", () => {
    const listing = create(base + 1_000);
    expect(repository.claimIfExpired(listing.id, base + 999)).toBeNull();
    expect(repository.claimIfExpired(listing.id, base + 1_000)?.active).toBe(false);
    expect(repository.claimIfExpired(listing.id, base + 1_001)).toBeNull();
    expect(() => create()).not.toThrow();
  });

  it("restores an active listing after the database is reopened", () => {
    database.close();
    const directory = mkdtempSync(join(tmpdir(), "live-server-bot-test-"));
    const path = join(directory, "listings.sqlite");
    try {
      database = openDatabase(path);
      repository = new ListingRepository(database);
      const listing = create();
      database.close();

      database = openDatabase(path);
      repository = new ListingRepository(database);
      expect(repository.listActive()).toEqual([expect.objectContaining({
        id: listing.id,
        ownerId: "owner",
        expiresAt: listing.expiresAt,
        liveMessageId: "message",
        controlMessageId: "panel"
      })]);
    } finally {
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
      database = openDatabase(":memory:");
      repository = new ListingRepository(database);
    }
  });
});
