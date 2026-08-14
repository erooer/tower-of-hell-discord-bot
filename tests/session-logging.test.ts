import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { sessionLogMessage, type SessionLogger } from "../src/logging/session-logger.js";
import { LiveServerService } from "../src/live-servers/service.js";
import type { Listing } from "../src/live-servers/model.js";
import { ModerationService } from "../src/moderation/service.js";
import type { PrivateServerVerifier } from "../src/roblox/private-server-verifier.js";
import { openDatabase } from "../src/storage/database.js";
import { HostCooldownRepository } from "../src/storage/host-cooldown-repository.js";
import { ListingRepository } from "../src/storage/listing-repository.js";
import { ModerationRepository } from "../src/storage/moderation-repository.js";

const config: Config = {
  token: "token", clientId: "client", guildId: "guild", liveChannelId: "live", commandsChannelId: "commands",
  carmineRoleId: "carmine-role", xpRoleId: "xp-role", eventRoleId: "event-role", staffReportsChannelId: "staff",
  sessionLogsChannelId: "logs", moderatorRoleId: "moderator-role", databasePath: ":memory:", expirationPollMs: 15_000
};
const oldUrl = "https://www.roblox.com/share?code=OldCode123&type=Server";
const newUrl = "https://www.roblox.com/share?code=NewCode123&type=Server";

describe("session action logging", () => {
  let database: Database.Database;
  let listings: ListingRepository;
  let moderation: ModerationRepository;
  let cooldowns: HostCooldownRepository;
  let currentTime: number;
  let logger: { log: ReturnType<typeof vi.fn> };
  let client: Client;
  let verifier: PrivateServerVerifier;
  let service: LiveServerService;
  let moderatorRolePresent: boolean;
  let fetchMember: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = openDatabase(":memory:");
    listings = new ListingRepository(database);
    moderation = new ModerationRepository(database);
    cooldowns = new HostCooldownRepository(database);
    currentTime = 1_800_000_000_000;
    logger = { log: vi.fn(async () => undefined) };
    moderatorRolePresent = false;
    let sent = 0;
    const message = { edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
    const channel = {
      isTextBased: () => true, isDMBased: () => false,
      send: vi.fn(async () => ({ id: `message-${++sent}` })),
      messages: { fetch: vi.fn(async () => message) }
    };
    fetchMember = vi.fn(async () => ({
      roles: { cache: { has: (roleId: string) => moderatorRolePresent && roleId === config.moderatorRoleId } }
    }));
    client = {
      channels: { fetch: vi.fn(async () => channel) },
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: fetchMember } })) }
    } as unknown as Client;
    verifier = {
      verify: vi.fn(async (url: string) => ({
        valid: true as const, originalUrl: url,
        resolvedUrl: "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=Code",
        placeId: "1962086868" as const
      }))
    };
    service = new LiveServerService(
      client, listings, config, () => currentTime, verifier, moderation, cooldowns, logger as SessionLogger
    );
  });
  afterEach(() => database.close());

  async function create(): Promise<Listing> {
    const result = await service.create("guild", "host", "xp", oldUrl);
    if (!result.ok) throw new Error(result.message);
    return result.listing;
  }

  it("logs successful creation, link change, extension, and manual ending once each", async () => {
    const listing = await create();
    expect(logger.log).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Session Created", listing: expect.objectContaining({ id: listing.id, ownerId: "host" }),
      actor: { kind: "host", userId: "host" }
    }));

    currentTime += 60_000;
    expect((await service.changeUrl(listing.id, "host", newUrl)).ok).toBe(true);
    expect(logger.log).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Server Link Changed" }));

    currentTime = listing.expiresAt - 5 * 60_000;
    expect((await service.extend(listing.id, "host")).ok).toBe(true);
    expect(logger.log).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Session Extended", action: "Extended session by +1 hour"
    }));

    expect((await service.end(listing.id, "host")).ok).toBe(true);
    expect(logger.log).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Session Ended", action: "Session manually ended",
      listing: expect.objectContaining({ ownerId: "host" }),
      actor: { kind: "host", userId: "host" }
    }));
    expect(logger.log.mock.calls.map((call) => call[0].title)).toEqual([
      "Session Created", "Server Link Changed", "Session Extended", "Session Ended"
    ]);
  });

  it("logs automatic expiration but reconciliation does not synthesize action logs", async () => {
    const listing = listings.create({
      guildId: "guild", ownerId: "host", type: "carmine", url: oldUrl,
      liveChannelId: "live", liveMessageId: "live-message", controlChannelId: "commands", controlMessageId: "control-message",
      createdAt: currentTime, expiresAt: currentTime + 1_000
    });
    currentTime += 2_000;
    await service.expire(listing.id);
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      title: "Session Ended", action: "Session expired", actor: { kind: "automatic" }
    }));

    logger.log.mockClear();
    const another = listings.create({
      guildId: "guild-2", ownerId: "host", type: "xp", url: oldUrl,
      liveChannelId: "live", liveMessageId: "live-2", controlChannelId: "commands", controlMessageId: "control-2",
      createdAt: currentTime - 10_000, expiresAt: currentTime - 1
    });
    await service.reconcileActive();
    expect(listings.get(another.id)?.active).toBe(false);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("allows an exact-role moderator to end another host's session and rejects everyone else", async () => {
    const listing = await create();
    logger.log.mockClear();

    await expect(service.end(listing.id, "ordinary-user")).resolves.toEqual({
      ok: false, message: "Only the session host or a moderator can end this session."
    });
    await expect(service.end(listing.id, "administrator-without-role")).resolves.toEqual({
      ok: false, message: "Only the session host or a moderator can end this session."
    });
    expect(listings.get(listing.id)?.active).toBe(true);
    expect(logger.log).not.toHaveBeenCalled();

    moderatorRolePresent = true;
    const result = await service.end(listing.id, "moderator");
    expect(result.ok).toBe(true);
    expect(fetchMember).toHaveBeenLastCalledWith("moderator");
    expect(listings.get(listing.id)?.endedReason).toBe("moderator_ended");
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      title: "Session Ended", action: "Session manually ended",
      listing: expect.objectContaining({ ownerId: "host" }),
      actor: { kind: "moderator", userId: "moderator" }
    }));
  });

  it("fails closed when a claimed moderator role cannot be revalidated", async () => {
    const listing = await create();
    moderatorRolePresent = false;
    expect((await service.end(listing.id, "stale-moderator")).ok).toBe(false);
    expect(fetchMember).toHaveBeenCalledWith("stale-moderator");
    expect(listings.get(listing.id)?.active).toBe(true);
  });

  it("logs manual public-message deletion once without guessing the actor", async () => {
    const listing = listings.create({
      guildId: "guild", ownerId: "host", type: "carmine", url: oldUrl,
      liveChannelId: "live", liveMessageId: "deleted-message", controlChannelId: "commands", controlMessageId: "control",
      createdAt: currentTime, expiresAt: currentTime + 7_200_000
    });
    await service.handleDeletedMessage("deleted-message");
    await service.handleDeletedMessage("deleted-message");
    expect(listings.get(listing.id)?.active).toBe(false);
    expect(logger.log).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(expect.objectContaining({
      title: "Session Ended", action: "Public listing manually deleted",
      actor: { kind: "automatic", label: "Manual message deletion (actor unknown)" }
    }));
  });

  it("logs Strike / Remove and Ignore Reports with the acting moderator", async () => {
    async function reportedListing(guildId: string, ownerId: string) {
      const listing = listings.create({
        guildId, ownerId, type: "xp", url: oldUrl,
        liveChannelId: "live", liveMessageId: `live-${guildId}`, controlChannelId: "commands", controlMessageId: `control-${guildId}`,
        createdAt: currentTime, expiresAt: currentTime + 7_200_000
      });
      for (let index = 1; index <= 7; index += 1) moderation.submitReport(listing, `${guildId}-r-${index}`, "staff", currentTime + index);
      return listing;
    }
    const moderationService = new ModerationService(
      client, listings, moderation, service, config, () => currentTime, cooldowns, logger as SessionLogger
    );
    const actor = { userId: "moderator", guildId: "guild", channelId: "staff", roleIds: ["moderator-role"] };

    const ignored = await reportedListing("ignore-guild", "ignored-host");
    expect((await moderationService.resolve(ignored.id, "ignore", actor)).ok).toBe(true);
    expect(logger.log).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Reports Ignored", actor: { kind: "moderator", userId: "moderator" }
    }));

    const struck = await reportedListing("strike-guild", "struck-host");
    expect((await moderationService.resolve(struck.id, "strike", actor)).ok).toBe(true);
    expect(logger.log).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Session Removed", listing: expect.objectContaining({ id: struck.id }),
      action: "Removed through moderation action (Strike / Remove)",
      actor: { kind: "moderator", userId: "moderator" }
    }));
  });

  it("does not fail the underlying action when log delivery fails", async () => {
    logger.log.mockRejectedValue(new Error("Discord unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await service.create("guild", "host", "xp", oldUrl);
    expect(result.ok).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("session log payload", () => {
  it("contains the host, actor, action, type, time, and listing without exposing the Roblox URL", () => {
    const listing = {
      id: "listing-id", guildId: "guild", ownerId: "host", type: "carmine" as const, url: oldUrl,
      liveChannelId: "live", liveMessageId: "message", controlChannelId: "commands", controlMessageId: "control",
      createdAt: 1_800_000_000_000, expiresAt: 1_800_007_200_000, active: false, cleanupPending: false,
      endedAt: 1_800_000_100_000, endedReason: "owner_ended", updatedAt: 1_800_000_100_000
    };
    const json = JSON.stringify(sessionLogMessage({
      title: "Session Ended", action: "Ended their session", listing,
      actor: { kind: "host", userId: "host" }, occurredAt: 1_800_000_100_000
    }));
    expect(json).toContain("Session Ended");
    expect(json).toContain("<@host>");
    expect(json).toContain("🔥 Carmine Hunting");
    expect(json).toContain("Ended their session");
    expect(json).toContain('"name":"Session by"');
    expect(json).toContain('"name":"Ended by"');
    expect(json).toContain('"name":"Reason"');
    expect(json).toContain("<t:1800000100:F>");
    expect(json).toContain("listing-id");
    expect(json).not.toContain(oldUrl);
  });

  it("identifies Event sessions as Event in session logs", () => {
    const eventListing: Listing = {
      id: "event-listing", guildId: "guild", ownerId: "event-host", type: "event", url: oldUrl,
      liveChannelId: "live", liveMessageId: "live", controlChannelId: "controls", controlMessageId: "control",
      createdAt: 1_800_000_000_000, expiresAt: 1_800_007_200_000, active: true, cleanupPending: false,
      endedAt: null, endedReason: null, updatedAt: 1_800_000_000_000
    };
    const json = JSON.stringify(sessionLogMessage({
      title: "Session Created", action: "Created a live-server session", listing: eventListing,
      actor: { kind: "host", userId: "event-host" }, occurredAt: 1_800_000_100_000
    }));
    expect(json).toContain('"name":"Type","value":"Event"');
    expect(json).not.toContain("XP Grinding");
    expect(json).not.toContain("Carmine Hunting");
  });
});
