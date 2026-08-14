import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
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
