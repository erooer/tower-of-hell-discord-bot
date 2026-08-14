import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { Events, MessageFlags, type Client } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { liveServerCommands } from "../src/commands/live-server-commands.js";
import { registerInteractionRouter } from "../src/interactions/router.js";
import type { LiveServerService } from "../src/live-servers/service.js";
import type { StaffActor } from "../src/moderation/model.js";
import { ModerationService } from "../src/moderation/service.js";
import { openDatabase } from "../src/storage/database.js";
import { HostCooldownRepository } from "../src/storage/host-cooldown-repository.js";
import { ListingRepository } from "../src/storage/listing-repository.js";
import { ModerationRepository } from "../src/storage/moderation-repository.js";

const targetId = "1234567890123456789";
const moderatorId = "2234567890123456789";
const now = 1_800_000_000_000;
const config = {
  guildId: "guild", commandsChannelId: "commands", moderatorRoleId: "moderator-role",
  staffReportsChannelId: "staff", sessionLogsChannelId: "logs"
} as Config;
const actor: StaffActor = {
  userId: moderatorId, guildId: "guild", channelId: "any-channel", roleIds: ["moderator-role"]
};

function moderatorClient(hasRole = true): Client {
  return {
    guilds: {
      fetch: vi.fn(async () => ({
        members: { fetch: vi.fn(async () => ({ roles: { cache: { has: () => hasRole } } })) }
      }))
    }
  } as unknown as Client;
}

describe("/hoststatus registration and routing", () => {
  it("registers /hoststatus with the required user ID option and keeps /hostgrind", () => {
    const commands = liveServerCommands as Array<{ name: string; options?: Array<{ name: string; required?: boolean }> }>;
    expect(commands.map((command) => command.name)).toEqual(["hostgrind", "hoststatus"]);
    expect(commands.find((command) => command.name === "hoststatus")?.options).toContainEqual(
      expect.objectContaining({ name: "user_id", required: true })
    );
  });

  function installRouter(moderation: Partial<ModerationService>) {
    let handler!: (interaction: any) => Promise<void>;
    const client = {
      on: vi.fn((event: string, callback: typeof handler) => {
        if (event === Events.InteractionCreate) handler = callback;
        return client;
      })
    } as unknown as Client;
    registerInteractionRouter(client, {} as LiveServerService, moderation as ModerationService, config);
    return handler;
  }

  function commandInteraction(roles: string[]) {
    return {
      commandName: "hoststatus", guildId: "guild", channelId: "commands", user: { id: moderatorId },
      member: { roles }, options: { getString: vi.fn(() => targetId) },
      isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false,
      isModalSubmit: () => false, isRepliable: () => true,
      reply: vi.fn(async (_payload: unknown) => undefined),
      deferReply: vi.fn(async (_payload: unknown) => undefined),
      editReply: vi.fn(async (_payload: unknown) => undefined), followUp: vi.fn(), deferred: false, replied: false
    };
  }

  it.each([
    { roles: [] as string[] },
    { roles: ["administrator-role"] }
  ])("denies a user without MODERATOR_ROLE_ID (roles: $roles)", async ({ roles }) => {
    const hostStatus = vi.fn();
    const handler = installRouter({ hostStatus });
    const interaction = commandInteraction(roles);
    await handler(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You are not authorized to manage host moderation status.",
      flags: MessageFlags.Ephemeral
    });
    expect(hostStatus).not.toHaveBeenCalled();
  });

  it("lets an exact-role moderator query a valid developer ID", async () => {
    const payload = { content: "", embeds: [], components: [] };
    const hostStatus = vi.fn(async () => ({ ok: true, message: "Loaded", hostStatusPayload: payload }));
    const handler = installRouter({ hostStatus });
    const interaction = commandInteraction(["moderator-role"]);
    await handler(interaction);
    expect(hostStatus).toHaveBeenCalledWith(targetId, expect.objectContaining({
      userId: moderatorId, guildId: "guild", roleIds: ["moderator-role"]
    }));
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith(payload);
  });
});

describe("host moderation status and reversals", () => {
  let database: Database.Database;
  let listings: ListingRepository;
  let moderation: ModerationRepository;
  let cooldowns: HostCooldownRepository;
  let service: ModerationService;
  let sequence = 0;

  beforeEach(() => {
    database = openDatabase(":memory:");
    listings = new ListingRepository(database);
    moderation = new ModerationRepository(database);
    cooldowns = new HostCooldownRepository(database);
    service = new ModerationService(
      moderatorClient(), listings, moderation,
      { moderationEnd: vi.fn() } as unknown as LiveServerService,
      config, () => now, cooldowns
    );
  });
  afterEach(() => database.close());

  function addStrike(hostId = targetId) {
    sequence += 1;
    const listing = listings.create({
      guildId: `guild-${sequence}`, ownerId: hostId, type: "xp",
      url: "https://www.roblox.com/share?code=Code123&type=Server",
      liveChannelId: "live", liveMessageId: `live-${sequence}`,
      controlChannelId: "commands", controlMessageId: `control-${sequence}`,
      createdAt: now + sequence, expiresAt: now + 7_200_000
    });
    for (let index = 1; index <= 7; index += 1) {
      moderation.submitReport(listing, `${sequence}-reporter-${index}`, "staff", now + index);
    }
    moderation.resolveCase(listing.id, "strike", moderatorId, now + 100 + sequence);
    return listing;
  }

  it("shows strikes, blacklists, report history, dates, and active cooldown", async () => {
    const listing = addStrike();
    moderation.blacklistReporter(targetId, moderatorId, "abuse", now + 200);
    moderation.submitReport(listing, targetId, "staff", now + 300);
    cooldowns.recordSuccessfulCreation(targetId, listing.id, now);

    const result = await service.hostStatus(targetId, actor);
    expect(result.ok).toBe(true);
    const json = JSON.stringify(result.hostStatusPayload);
    expect(json).toContain(`${targetId}`);
    expect(json).toContain('"name":"Host Strikes","value":"1 / 3"');
    expect(json).toContain('"name":"Host Blacklisted","value":"No"');
    expect(json).toContain('"name":"Reporter Blacklisted","value":"Yes"');
    expect(json).toContain("Active — ends");
    expect(json).toContain("total");
    expect(json).toContain("Remove Strike");
    expect(json).toContain("Remove Reporter Blacklist");
    expect(json).toContain("Clear Cooldown");
  });

  it("removes exactly the selected strike, auto-clears a strike blacklist, and rejects a stale double-click", async () => {
    addStrike(); addStrike(); addStrike();
    const before = moderation.getHostModerationStatus(targetId);
    expect(before.strikeCount).toBe(3);
    expect(before.hostBlacklisted).toBe(true);
    const statusJson = JSON.stringify((await service.hostStatus(targetId, actor)).hostStatusPayload);
    expect(statusJson).toContain('"name":"Host Strikes","value":"3 / 3"');
    expect(statusJson).toContain('"name":"Host Blacklisted","value":"Yes"');

    const first = await service.updateHostStatus(targetId, "strike", before.latestActiveStrikeId, actor);
    expect(first.ok).toBe(true);
    expect(moderation.getHostModerationStatus(targetId)).toMatchObject({ strikeCount: 2, hostBlacklisted: false });
    expect(moderation.listStatusAudit(targetId).map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "strike_revoked", "host_blacklist_removed"
    ]));

    const stale = await service.updateHostStatus(targetId, "strike", before.latestActiveStrikeId, actor);
    expect(stale.ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(2);
  });

  it("safely rejects strike removal when no active strike exists", async () => {
    const result = await service.updateHostStatus(targetId, "strike", null, actor);
    expect(result.ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(0);
    expect(moderation.listStatusAudit(targetId)).toEqual([]);
  });

  it("removes a host blacklist without erasing strikes", async () => {
    addStrike(); addStrike(); addStrike();
    expect((await service.updateHostStatus(targetId, "host-unblacklist", null, actor)).ok).toBe(true);
    expect(moderation.isHostBlacklisted(targetId)).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(3);
    expect((await service.updateHostStatus(targetId, "host-unblacklist", null, actor)).ok).toBe(false);
  });

  it("removes a reporter blacklist without changing report history", async () => {
    const listing = addStrike("other-host");
    moderation.submitReport(listing, targetId, "staff", now + 500);
    moderation.blacklistReporter(targetId, moderatorId, "abuse", now + 600);
    const history = moderation.reporterHistory(targetId);
    expect((await service.updateHostStatus(targetId, "reporter-unblacklist", null, actor)).ok).toBe(true);
    expect(moderation.isReporterBlacklisted(targetId)).toBe(false);
    expect(moderation.reporterHistory(targetId)).toEqual(history);
  });

  it("refetches the acting member role before destructive changes", async () => {
    const denied = new ModerationService(
      moderatorClient(false), listings, moderation,
      { moderationEnd: vi.fn() } as unknown as LiveServerService,
      config, () => now, cooldowns
    );
    addStrike();
    const strikeId = moderation.getHostModerationStatus(targetId).latestActiveStrikeId;
    expect((await denied.updateHostStatus(targetId, "strike", strikeId, actor)).ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(1);
  });

  it("clears only the stored cooldown and audits stale-safe behavior", async () => {
    const listing = addStrike();
    cooldowns.recordSuccessfulCreation(targetId, listing.id, now);
    expect((await service.updateHostStatus(targetId, "cooldown", null, actor)).ok).toBe(true);
    expect(cooldowns.get(targetId)).toBeNull();
    expect(moderation.listStatusAudit(targetId)).toContainEqual(expect.objectContaining({ action: "cooldown_cleared" }));
    expect((await service.updateHostStatus(targetId, "cooldown", null, actor)).ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(1);
  });
});

describe("host-status persistence", () => {
  it("preserves revocations, blacklist removals, and audit history after reload", () => {
    const directory = mkdtempSync(join(tmpdir(), "host-status-"));
    const path = join(directory, "bot.sqlite");
    try {
      let database = openDatabase(path);
      let listings = new ListingRepository(database);
      let moderation = new ModerationRepository(database);
      const listing = listings.create({
        guildId: "guild", ownerId: targetId, type: "xp", url: "https://www.roblox.com/share?code=Code123&type=Server",
        liveChannelId: "live", liveMessageId: "live", controlChannelId: "commands", controlMessageId: "control",
        createdAt: now, expiresAt: now + 7_200_000
      });
      for (let index = 1; index <= 7; index += 1) moderation.submitReport(listing, `r-${index}`, "staff", now + index);
      moderation.resolveCase(listing.id, "strike", moderatorId, now + 10);
      const strikeId = moderation.getHostModerationStatus(targetId).latestActiveStrikeId!;
      expect(moderation.revokeStrike(targetId, strikeId, moderatorId, now + 20)).toBe(true);
      database.close();

      database = openDatabase(path);
      listings = new ListingRepository(database);
      moderation = new ModerationRepository(database);
      expect(moderation.getHostStrikeCount(targetId)).toBe(0);
      expect(moderation.listStatusAudit(targetId)).toContainEqual(expect.objectContaining({
        action: "strike_revoked", moderatorId, relatedId: strikeId
      }));
      const row = database.prepare("SELECT active, revoked_at, revoked_by FROM host_strikes WHERE id=?").get(strikeId);
      expect(row).toEqual({ active: 0, revoked_at: now + 20, revoked_by: moderatorId });
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("safely adds reversal metadata to a legacy moderation database", () => {
    const directory = mkdtempSync(join(tmpdir(), "host-status-migration-"));
    const path = join(directory, "legacy.sqlite");
    try {
      const legacy = new BetterSqlite3(path);
      legacy.exec(`
        CREATE TABLE host_strikes (
          id TEXT PRIMARY KEY, host_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE,
          moderator_id TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE host_blacklist (
          user_id TEXT PRIMARY KEY, blacklisted_at INTEGER NOT NULL,
          triggering_session_id TEXT NOT NULL, moderator_id TEXT NOT NULL
        );
        CREATE TABLE reporter_blacklist (
          user_id TEXT PRIMARY KEY, blacklisted_at INTEGER NOT NULL,
          moderator_id TEXT NOT NULL, reason TEXT
        );
        INSERT INTO host_strikes VALUES ('strike','${targetId}','session','${moderatorId}',${now},1);
        INSERT INTO host_blacklist VALUES ('${targetId}',${now},'session','${moderatorId}');
        INSERT INTO reporter_blacklist VALUES ('${targetId}',${now},'${moderatorId}','legacy');
      `);
      legacy.close();

      const migrated = openDatabase(path);
      const repository = new ModerationRepository(migrated);
      expect(repository.getHostModerationStatus(targetId)).toMatchObject({
        strikeCount: 1, hostBlacklisted: true, reporterBlacklisted: true
      });
      const strikeColumns = (migrated.prepare("PRAGMA table_info(host_strikes)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(strikeColumns).toEqual(expect.arrayContaining(["revoked_at", "revoked_by"]));
      expect(repository.removeReporterBlacklist(targetId, moderatorId, now + 1)).toBe(true);
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
