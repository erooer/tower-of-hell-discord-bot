import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Listing } from "../src/live-servers/model.js";
import { openDatabase } from "../src/storage/database.js";
import { ListingRepository } from "../src/storage/listing-repository.js";
import { ModerationRepository } from "../src/storage/moderation-repository.js";

describe("ModerationRepository", () => {
  let database: Database.Database;
  let listings: ListingRepository;
  let moderation: ModerationRepository;
  let sequence = 0;
  const now = 1_800_000_000_000;

  beforeEach(() => {
    database = openDatabase(":memory:");
    listings = new ListingRepository(database);
    moderation = new ModerationRepository(database);
  });
  afterEach(() => database.close());

  function listing(hostId = "host"): Listing {
    sequence += 1;
    return listings.create({
      guildId: `guild-${sequence}`, ownerId: hostId, type: "xp",
      url: "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=ValidCode123",
      liveChannelId: "live", liveMessageId: `live-${sequence}`,
      controlChannelId: "controls", controlMessageId: `control-${sequence}`,
      createdAt: now + sequence, expiresAt: now + 7_200_000
    });
  }

  function escalate(session: Listing, prefix = "reporter"): void {
    for (let index = 1; index <= 7; index += 1) {
      moderation.submitReport(session, `${prefix}-${index}`, "staff", now + index);
    }
  }

  it("counts one report per user per session and allows different users", () => {
    const session = listing();
    expect(moderation.submitReport(session, "user-1", "staff", now)).toMatchObject({ ok: true, count: 1 });
    expect(moderation.submitReport(session, "user-1", "staff", now + 1)).toEqual({ ok: false, reason: "duplicate" });
    expect(moderation.submitReport(session, "user-2", "staff", now + 2)).toMatchObject({ ok: true, count: 2 });
    expect(moderation.getReportCount(session.id)).toBe(2);
  });

  it("creates one escalation exactly at seven and report eight cannot duplicate it", () => {
    const session = listing();
    for (let index = 1; index <= 6; index += 1) {
      expect(moderation.submitReport(session, `user-${index}`, "staff", now + index))
        .toMatchObject({
          ok: true, count: index, escalatedNow: false,
          moderationCase: { sessionId: session.id, urgentEscalatedAt: null }
        });
    }
    expect(moderation.submitReport(session, "user-7", "staff", now + 7))
      .toMatchObject({
        ok: true, count: 7, escalatedNow: true,
        moderationCase: { status: "open", urgentEscalatedAt: now + 7 }
      });
    expect(moderation.submitReport(session, "user-8", "staff", now + 8))
      .toMatchObject({ ok: true, count: 8, escalatedNow: false, moderationCase: { status: "open" } });
    expect(moderation.listCases()).toHaveLength(1);
  });

  it("blocks blacklisted reporters without storing or counting a report", () => {
    const session = listing();
    expect(moderation.blacklistReporter("troll", "moderator", "abuse", now)).toBe(true);
    expect(moderation.blacklistReporter("troll", "moderator", null, now + 1)).toBe(false);
    expect(moderation.submitReport(session, "troll", "staff", now + 2)).toEqual({ ok: false, reason: "blacklisted" });
    expect(moderation.getReportCount(session.id)).toBe(0);
  });

  it("returns unique reporters with correct cross-session history", () => {
    const first = listing();
    const second = listing();
    moderation.submitReport(first, "user", "staff", now);
    escalate(first, "other");
    moderation.resolveCase(first.id, "strike", "moderator", now + 20);
    moderation.submitReport(second, "user", "staff", now + 30);
    escalate(second, "another");
    moderation.resolveCase(second.id, "ignore", "moderator", now + 40);

    expect(moderation.reporterHistory("user")).toEqual({ total: 2, valid: 1, rejected: 1 });
    expect(moderation.getReporterSummaries(second.id)).toContainEqual(expect.objectContaining({
      userId: "user", total: 2, valid: 1, rejected: 1
    }));
  });

  it("ignore marks reports rejected and cannot resolve the case twice", () => {
    const session = listing();
    escalate(session);
    expect(moderation.resolveCase(session.id, "ignore", "mod-1", now + 100)).toMatchObject({
      ok: true, moderationCase: { status: "ignored", resolvedBy: "mod-1" }, strikeCount: 0
    });
    expect(moderation.reporterHistory("reporter-1")).toEqual({ total: 1, valid: 0, rejected: 1 });
    expect(moderation.resolveCase(session.id, "strike", "mod-2", now + 101)).toEqual({ ok: false, reason: "resolved" });
    expect(moderation.getHostStrikeCount("host")).toBe(0);
    expect(moderation.submitReport(session, "late-reporter", "staff", now + 102)).toMatchObject({ ok: true, count: 8 });
    expect(moderation.reporterHistory("late-reporter")).toEqual({ total: 1, valid: 0, rejected: 1 });
  });

  it("strike marks reports valid and gives at most one host strike per case", () => {
    const session = listing();
    escalate(session);
    expect(moderation.resolveCase(session.id, "strike", "mod", now + 100)).toMatchObject({ ok: true, strikeCount: 1 });
    expect(moderation.reporterHistory("reporter-1")).toEqual({ total: 1, valid: 1, rejected: 0 });
    expect(moderation.resolveCase(session.id, "strike", "mod", now + 101)).toEqual({ ok: false, reason: "resolved" });
    expect(moderation.getHostStrikeCount("host")).toBe(1);
  });

  it("blacklists a host persistently upon the third valid strike", () => {
    for (let strike = 1; strike <= 3; strike += 1) {
      const session = listing("repeat-host");
      escalate(session, `s${strike}`);
      const result = moderation.resolveCase(session.id, "strike", `mod-${strike}`, now + strike * 100);
      expect(result).toMatchObject({ ok: true, strikeCount: strike, hostBlacklisted: strike === 3 });
    }
    expect(moderation.getHostStrikeCount("repeat-host")).toBe(3);
    expect(moderation.isHostBlacklisted("repeat-host")).toBe(true);
  });

  it("persists reporter blacklist, strikes, report counts, and escalation state after reopen", () => {
    database.close();
    const directory = mkdtempSync(join(tmpdir(), "moderation-persistence-"));
    const path = join(directory, "bot.sqlite");
    try {
      database = openDatabase(path);
      listings = new ListingRepository(database);
      moderation = new ModerationRepository(database);
      const session = listing("persistent-host");
      escalate(session);
      moderation.setCaseMessage(session.id, "staff-message", now + 10);
      expect(moderation.claimUrgentPing(session.id, now + 11)).toBe(true);
      moderation.setUrgentMessage(session.id, "urgent-message", now + 12);
      moderation.resolveCase(session.id, "strike", "moderator", now + 20);
      moderation.blacklistReporter("troll", "moderator", null, now + 30);
      database.close();

      database = openDatabase(path);
      moderation = new ModerationRepository(database);
      expect(moderation.isReporterBlacklisted("troll")).toBe(true);
      expect(moderation.getHostStrikeCount("persistent-host")).toBe(1);
      expect(moderation.getReportCount(session.id)).toBe(7);
      expect(moderation.getCase(session.id)).toMatchObject({
        staffMessageId: "staff-message", urgentMessageId: "urgent-message",
        urgentEscalatedAt: expect.any(Number), urgentPingedAt: now + 11,
        status: "struck", resolvedBy: "moderator"
      });
    } finally {
      if (database.open) database.close();
      rmSync(directory, { recursive: true, force: true });
      database = openDatabase(":memory:");
    }
  });
});
