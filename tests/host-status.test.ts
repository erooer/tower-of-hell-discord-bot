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
import type { SessionLogger } from "../src/logging/session-logger.js";
import { sessionLogMessage } from "../src/logging/session-logger.js";

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

  it("edits the same ephemeral response with regenerated controls after a button action", async () => {
    const payload: any = { content: "Added one host strike.", embeds: [{ title: "refreshed" }], components: [{ refreshed: true }] };
    const updateHostStatus = vi.fn(async () => ({ ok: true, message: "Updated", hostStatusPayload: payload }));
    const handler = installRouter({ updateHostStatus });
    const interaction = {
      customId: `hoststatus:strike-add:${targetId}:0`, guildId: "guild", channelId: "commands",
      user: { id: moderatorId }, member: { roles: ["moderator-role"] },
      isChatInputCommand: () => false, isButton: () => true, isStringSelectMenu: () => false,
      isModalSubmit: () => false, isRepliable: () => true,
      deferUpdate: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined),
      reply: vi.fn(), followUp: vi.fn(), deferred: false, replied: false
    };
    await handler(interaction);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(updateHostStatus).toHaveBeenCalledWith(targetId, "strike-add", "0", expect.objectContaining({ userId: moderatorId }));
    expect(interaction.editReply).toHaveBeenCalledWith(payload);
    expect(interaction.reply).not.toHaveBeenCalled();
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
    expect(json).toContain("Add Strike");
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

    const first = await service.updateHostStatus(targetId, "strike-remove", before.latestActiveStrikeId, actor);
    expect(first.ok).toBe(true);
    expect(moderation.getHostModerationStatus(targetId)).toMatchObject({ strikeCount: 2, hostBlacklisted: false });
    expect(moderation.listStatusAudit(targetId).map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "strike_revoked", "host_blacklist_removed"
    ]));

    const stale = await service.updateHostStatus(targetId, "strike-remove", before.latestActiveStrikeId, actor);
    expect(stale.ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(2);
  });

  it("safely rejects strike removal when no active strike exists", async () => {
    const result = await service.updateHostStatus(targetId, "strike-remove", null, actor);
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
    expect((await denied.updateHostStatus(targetId, "strike-remove", strikeId, actor)).ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(1);
  });

  it("clears only the stored cooldown and audits stale-safe behavior", async () => {
    const listing = addStrike();
    cooldowns.recordSuccessfulCreation(targetId, listing.id, now);
    expect((await service.updateHostStatus(targetId, "cooldown-clear", String(now), actor)).ok).toBe(true);
    expect(cooldowns.get(targetId)).toBeNull();
    expect(moderation.listStatusAudit(targetId)).toContainEqual(expect.objectContaining({ action: "cooldown_cleared" }));
    expect((await service.updateHostStatus(targetId, "cooldown-clear", String(now), actor)).ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(1);
  });

  it("always renders a complete usable control panel for a clean account", async () => {
    const payload = (await service.hostStatus(targetId, actor)).hostStatusPayload!;
    const json = JSON.stringify(payload);
    expect(json).toContain('"name":"Host Strikes","value":"0 / 3"');
    expect(json).toContain("Add Strike");
    expect(json).toContain("Remove Strike");
    expect(json).toContain("Add Host Blacklist");
    expect(json).toContain("Add Reporter Blacklist");
    expect(json).toContain("Add Cooldown");
    const buttons = (payload.components![0] as any).components.map((button: any) => button.toJSON());
    expect(buttons).toHaveLength(5);
    expect(buttons.find((button: any) => button.label === "Add Strike").disabled).toBe(false);
    expect(buttons.find((button: any) => button.label === "Remove Strike").disabled).toBe(true);
  });

  it("adds and removes strikes across 0-3 while keeping both controls visible and bounded", async () => {
    for (let expected = 0; expected < 3; expected += 1) {
      const result = await service.updateHostStatus(targetId, "strike-add", String(expected), actor);
      expect(result.ok).toBe(true);
      expect(moderation.getHostStrikeCount(targetId)).toBe(expected + 1);
      const json = JSON.stringify(result.hostStatusPayload);
      expect(json).toContain("Add Strike");
      expect(json).toContain("Remove Strike");
      const stateButtons = (result.hostStatusPayload!.components![0] as any).components.map((button: any) => button.toJSON());
      expect(stateButtons.find((button: any) => button.label === "Add Strike").disabled).toBe(expected + 1 >= 3);
      expect(stateButtons.find((button: any) => button.label === "Remove Strike").disabled).toBe(false);
    }
    const atCap = (await service.hostStatus(targetId, actor)).hostStatusPayload!;
    const buttons = (atCap.components![0] as any).components.map((button: any) => button.toJSON());
    expect(buttons.find((button: any) => button.label === "Add Strike").disabled).toBe(true);
    expect(buttons.find((button: any) => button.label === "Remove Strike").disabled).toBe(false);
    expect((await service.updateHostStatus(targetId, "strike-add", "3", actor)).ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(3);

    for (let expected = 3; expected > 0; expected -= 1) {
      const strikeId = moderation.getHostModerationStatus(targetId).latestActiveStrikeId;
      expect((await service.updateHostStatus(targetId, "strike-remove", strikeId, actor)).ok).toBe(true);
      expect(moderation.getHostStrikeCount(targetId)).toBe(expected - 1);
    }
    expect((await service.updateHostStatus(targetId, "strike-remove", "none", actor)).ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(0);
  });

  it("toggles both blacklists and cooldown and refreshes each opposite control", async () => {
    let result = await service.updateHostStatus(targetId, "host-blacklist", null, actor);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.hostStatusPayload)).toContain("Remove Host Blacklist");
    result = await service.updateHostStatus(targetId, "host-unblacklist", null, actor);
    expect(JSON.stringify(result.hostStatusPayload)).toContain("Add Host Blacklist");
    expect(JSON.stringify(result.hostStatusPayload)).toContain('"name":"Host Blacklisted At","value":"None"');

    result = await service.updateHostStatus(targetId, "reporter-blacklist", null, actor);
    expect(JSON.stringify(result.hostStatusPayload)).toContain("Remove Reporter Blacklist");
    result = await service.updateHostStatus(targetId, "reporter-unblacklist", null, actor);
    expect(JSON.stringify(result.hostStatusPayload)).toContain("Add Reporter Blacklist");
    expect(JSON.stringify(result.hostStatusPayload)).toContain('"name":"Reporter Blacklisted At","value":"None"');

    result = await service.updateHostStatus(targetId, "cooldown-add", "none", actor);
    expect(result.ok).toBe(true);
    expect(cooldowns.get(targetId)?.nextEligibleAt).toBe(now + 3 * 60 * 60 * 1_000);
    expect(JSON.stringify(result.hostStatusPayload)).toContain("Clear Cooldown");
    result = await service.updateHostStatus(targetId, "cooldown-clear", String(now), actor);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.hostStatusPayload)).toContain("Add Cooldown");
  });

  it("rejects stale add clicks and writes private moderation logs for every successful action", async () => {
    const events: any[] = [];
    const loggedService = new ModerationService(
      moderatorClient(), listings, moderation,
      { moderationEnd: vi.fn() } as unknown as LiveServerService,
      config, () => now, cooldowns, { log: vi.fn(async (event) => { events.push(event); }) } as SessionLogger
    );
    expect((await loggedService.updateHostStatus(targetId, "strike-add", "0", actor)).ok).toBe(true);
    expect((await loggedService.updateHostStatus(targetId, "strike-add", "0", actor)).ok).toBe(false);
    expect(moderation.getHostStrikeCount(targetId)).toBe(1);
    expect((await loggedService.updateHostStatus(targetId, "host-blacklist", null, actor)).ok).toBe(true);
    expect((await loggedService.updateHostStatus(targetId, "reporter-blacklist", null, actor)).ok).toBe(true);
    expect((await loggedService.updateHostStatus(targetId, "cooldown-add", "none", actor)).ok).toBe(true);
    const strikeId = moderation.getHostModerationStatus(targetId).latestActiveStrikeId;
    expect((await loggedService.updateHostStatus(targetId, "strike-remove", strikeId, actor)).ok).toBe(true);
    expect((await loggedService.updateHostStatus(targetId, "host-unblacklist", null, actor)).ok).toBe(true);
    expect((await loggedService.updateHostStatus(targetId, "reporter-unblacklist", null, actor)).ok).toBe(true);
    expect((await loggedService.updateHostStatus(targetId, "cooldown-clear", String(now), actor)).ok).toBe(true);
    expect(events).toHaveLength(8);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "host-status", targetUserId: targetId, moderatorId, occurredAt: now
    })]));
    expect(events.every((event) => event.result.includes("strikes"))).toBe(true);
    const logJson = JSON.stringify(sessionLogMessage(events[0]));
    expect(logJson).toContain(`\"name\":\"Target\",\"value\":\"<@${targetId}>\"`);
    expect(logJson).toContain('"name":"Developer ID","value":"`' + targetId + '`"');
    expect(logJson).toContain(`\"name\":\"Moderator\",\"value\":\"<@${moderatorId}>\"`);
  });
});

describe("host-status persistence", () => {
  it("preserves moderator-added strikes, blacklists, cooldowns, and audit history after reload", () => {
    const directory = mkdtempSync(join(tmpdir(), "host-status-added-"));
    const path = join(directory, "bot.sqlite");
    try {
      let database = openDatabase(path);
      let moderation = new ModerationRepository(database);
      expect(moderation.addHostStrike(targetId, moderatorId, now, 0)).toBe(true);
      expect(moderation.addHostBlacklist(targetId, moderatorId, now + 1)).toBe(true);
      expect(moderation.addReporterBlacklist(targetId, moderatorId, now + 2)).toBe(true);
      expect(moderation.addHostCooldown(targetId, moderatorId, now + 3)).toBe(true);
      database.close();

      database = openDatabase(path);
      moderation = new ModerationRepository(database);
      const cooldowns = new HostCooldownRepository(database);
      expect(moderation.getHostModerationStatus(targetId)).toMatchObject({
        strikeCount: 1, hostBlacklisted: true, reporterBlacklisted: true
      });
      expect(cooldowns.get(targetId)?.successfulCreationAt).toBe(now + 3);
      expect(moderation.listStatusAudit(targetId).map((entry) => entry.action)).toEqual([
        "strike_added", "host_blacklist_added", "reporter_blacklist_added", "cooldown_added"
      ]);
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
