import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { LiveServerService } from "../src/live-servers/service.js";
import { liveMessage } from "../src/live-servers/messages.js";
import type { PrivateServerVerifier, RobloxVerificationResult } from "../src/roblox/private-server-verifier.js";
import { openDatabase } from "../src/storage/database.js";
import { ListingRepository } from "../src/storage/listing-repository.js";
import { HostCooldownRepository, HOST_COOLDOWN_MS } from "../src/storage/host-cooldown-repository.js";
import { ModerationRepository } from "../src/storage/moderation-repository.js";

const oldUrl = "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=OldCode12345";
const newUrl = "https://www.roblox.com/share?code=NewCode12345&type=Server";
const config: Config = {
  token: "token", clientId: "client", guildId: "guild", liveChannelId: "live",
  commandsChannelId: "controls", carmineRoleId: "carmine-role", xpRoleId: "xp-role",
  staffReportsChannelId: "staff", moderatorRoleId: "moderator-role",
  databasePath: ":memory:", expirationPollMs: 15_000
};

describe("LiveServerService verification boundary", () => {
  let database: Database.Database;
  let repository: ListingRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    repository = new ListingRepository(database);
  });
  afterEach(() => database.close());

  function publishingClient(roleIds: Set<string>): Client {
    const message = { edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
    const channel = {
      isTextBased: () => true,
      isDMBased: () => false,
      send: vi.fn(async () => ({ id: `message-${Math.random()}` })),
      messages: { fetch: vi.fn(async () => message) }
    };
    return {
      channels: { fetch: vi.fn(async () => channel) },
      guilds: {
        fetch: vi.fn(async () => ({
          members: {
            fetch: vi.fn(async () => ({ roles: { cache: { has: (roleId: string) => roleIds.has(roleId) } } }))
          }
        }))
      }
    } as unknown as Client;
  }

  function acceptingVerifier(): PrivateServerVerifier {
    return {
      verify: vi.fn(async (url: string) => ({
        valid: true as const,
        originalUrl: url,
        resolvedUrl: "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=Code",
        placeId: "1962086868" as const
      }))
    };
  }

  it("does not create a record, fetch a Discord channel, or ping before verification succeeds", async () => {
    let finishVerification!: (result: RobloxVerificationResult) => void;
    const verifier: PrivateServerVerifier = {
      verify: vi.fn(() => new Promise<RobloxVerificationResult>((resolve) => { finishVerification = resolve; }))
    };
    const fetchChannel = vi.fn();
    const client = { channels: { fetch: fetchChannel } } as unknown as Client;
    const service = new LiveServerService(client, repository, config, () => 1_800_000_000_000, verifier);

    const pending = service.create("guild", "owner", "carmine", newUrl);
    await vi.waitFor(() => expect(verifier.verify).toHaveBeenCalledOnce());
    expect(repository.listActive()).toEqual([]);
    expect(fetchChannel).not.toHaveBeenCalled();

    finishVerification({ valid: false, reason: "wrong_place", originalUrl: newUrl, placeId: "123" });
    await expect(pending).resolves.toEqual({ ok: false, message: "This private server is not for Tower of Hell." });
    expect(repository.listActive()).toEqual([]);
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it("publishes only after a pending verification succeeds", async () => {
    let finishVerification!: (result: RobloxVerificationResult) => void;
    const verifier: PrivateServerVerifier = {
      verify: vi.fn(() => new Promise<RobloxVerificationResult>((resolve) => { finishVerification = resolve; }))
    };
    const liveSend = vi.fn(async (_payload: unknown) => ({ id: "live-message" }));
    const controlSend = vi.fn(async (_payload: unknown) => ({ id: "control-message" }));
    const liveChannel = { isTextBased: () => true, isDMBased: () => false, send: liveSend };
    const controlChannel = { isTextBased: () => true, isDMBased: () => false, send: controlSend };
    const fetchChannel = vi.fn(async (id: string) => id === "live" ? liveChannel : controlChannel);
    const client = { channels: { fetch: fetchChannel } } as unknown as Client;
    const service = new LiveServerService(client, repository, config, () => 1_800_000_000_000, verifier);

    const pending = service.create("guild", "owner", "carmine", newUrl);
    await vi.waitFor(() => expect(verifier.verify).toHaveBeenCalledOnce());
    expect(repository.listActive()).toEqual([]);
    expect(liveSend).not.toHaveBeenCalled();
    expect(controlSend).not.toHaveBeenCalled();

    finishVerification({
      valid: true,
      originalUrl: newUrl,
      resolvedUrl: "https://www.roblox.com/share-links?code=NewCode12345&type=Server",
      placeId: "1962086868"
    });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(repository.listActive()).toHaveLength(1);
    expect(liveSend).toHaveBeenCalledOnce();
    expect(liveSend.mock.calls[0]?.[0]).toMatchObject({ content: "<@&carmine-role>" });
    expect(controlSend).toHaveBeenCalledOnce();
  });

  it("starts a cross-type cooldown only after successful publication and permits hosting at three hours", async () => {
    let currentTime = 1_800_000_000_000;
    const verifier: PrivateServerVerifier = {
      verify: vi.fn(async (url: string) => ({
        valid: true as const, originalUrl: url,
        resolvedUrl: "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=Code",
        placeId: "1962086868" as const
      }))
    };
    const message = { edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
    const channel = {
      isTextBased: () => true, isDMBased: () => false,
      send: vi.fn(async () => ({ id: `message-${Math.random()}` })),
      messages: { fetch: vi.fn(async () => message) }
    };
    const client = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
    const cooldowns = new HostCooldownRepository(database);
    const service = new LiveServerService(
      client, repository, config, () => currentTime, verifier, undefined, cooldowns
    );

    const first = await service.create("guild", "owner", "carmine", newUrl);
    expect(first.ok).toBe(true);
    expect(cooldowns.get("owner")?.nextEligibleAt).toBe(currentTime + HOST_COOLDOWN_MS);

    currentTime += 60 * 60 * 1_000;
    await expect(service.create("guild", "owner", "xp", newUrl)).resolves.toEqual({
      ok: false,
      message: "You can host another server <t:1800010800:R>."
    });
    expect(verifier.verify).toHaveBeenCalledTimes(1);

    currentTime = 1_800_000_000_000 + HOST_COOLDOWN_MS;
    const second = await service.create("guild", "owner", "xp", newUrl);
    expect(second.ok).toBe(true);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["carmine" as const, "xp" as const],
    ["xp" as const, "carmine" as const]
  ])("lets an exact-role moderator create %s during a cooldown started by %s", async (targetType, previousType) => {
    let currentTime = 1_800_000_000_000;
    const roles = new Set([config.moderatorRoleId]);
    const cooldowns = new HostCooldownRepository(database);
    const verifier = acceptingVerifier();
    const service = new LiveServerService(
      publishingClient(roles), repository, config, () => currentTime, verifier, undefined, cooldowns
    );

    const first = await service.create("guild", "moderator", previousType, newUrl);
    if (!first.ok) throw new Error(first.message);
    const firstCooldown = cooldowns.get("moderator")!;

    currentTime += 60 * 60 * 1_000;
    const second = await service.create("guild", "moderator", targetType, newUrl);
    if (!second.ok) throw new Error(second.message);
    const updatedCooldown = cooldowns.get("moderator")!;

    expect(updatedCooldown.listingId).toBe(second.listing.id);
    expect(updatedCooldown.successfulCreationAt).toBe(currentTime);
    expect(updatedCooldown.nextEligibleAt).toBe(currentTime + HOST_COOLDOWN_MS);
    expect(updatedCooldown.successfulCreationAt).toBeGreaterThan(firstCooldown.successfulCreationAt);
  });

  it("enforces the persisted cooldown again after the moderator role is removed", async () => {
    let currentTime = 1_800_000_000_000;
    const roles = new Set([config.moderatorRoleId]);
    const cooldowns = new HostCooldownRepository(database);
    const verifier = acceptingVerifier();
    const service = new LiveServerService(
      publishingClient(roles), repository, config, () => currentTime, verifier, undefined, cooldowns
    );
    expect((await service.create("guild", "moderator", "carmine", newUrl)).ok).toBe(true);

    currentTime += 60 * 60 * 1_000;
    roles.clear();
    roles.add("administrator-role");
    await expect(service.create("guild", "moderator", "xp", newUrl)).resolves.toEqual({
      ok: false,
      message: "You can host another server <t:1800010800:R>."
    });
    expect(verifier.verify).toHaveBeenCalledOnce();
  });

  it("does not let the moderator cooldown bypass override the host blacklist", async () => {
    const verifier = acceptingVerifier();
    const cooldowns = new HostCooldownRepository(database);
    const service = new LiveServerService(
      publishingClient(new Set([config.moderatorRoleId])),
      repository,
      config,
      () => 1_800_000_000_000,
      verifier,
      { isHostBlacklisted: () => true },
      cooldowns
    );
    await expect(service.create("guild", "moderator", "xp", newUrl)).resolves.toEqual({
      ok: false,
      message: "You are blacklisted from creating live-server announcements. Contact a moderator to appeal."
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("does not let the moderator cooldown bypass override active-listing restrictions", async () => {
    let currentTime = 1_800_000_000_000;
    const verifier = acceptingVerifier();
    const service = new LiveServerService(
      publishingClient(new Set([config.moderatorRoleId])),
      repository,
      config,
      () => currentTime,
      verifier,
      undefined,
      new HostCooldownRepository(database)
    );
    expect((await service.create("guild", "moderator", "carmine", newUrl)).ok).toBe(true);
    currentTime += 60 * 60 * 1_000;
    await expect(service.create("guild", "moderator", "carmine", newUrl)).resolves.toEqual({
      ok: false,
      message: "You already have an active listing of this type. Use its existing control panel."
    });
    expect(verifier.verify).toHaveBeenCalledOnce();
  });

  it("does not consume cooldown on failed publication", async () => {
    const verifier: PrivateServerVerifier = {
      verify: vi.fn(async (url: string) => ({
        valid: true as const, originalUrl: url,
        resolvedUrl: "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=Code",
        placeId: "1962086868" as const
      }))
    };
    const channel = {
      isTextBased: () => true, isDMBased: () => false,
      send: vi.fn(async () => { throw new Error("missing permission"); })
    };
    const cooldowns = new HostCooldownRepository(database);
    const service = new LiveServerService(
      { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client,
      repository, config, () => 1_800_000_000_000, verifier, undefined, cooldowns
    );

    const result = await service.create("guild", "owner", "carmine", newUrl);
    expect(result.ok).toBe(false);
    expect(cooldowns.get("owner")).toBeNull();
  });

  it("does not reset cooldown when changing a link or extending", async () => {
    let currentTime = 1_800_000_000_000;
    const verifier: PrivateServerVerifier = {
      verify: vi.fn(async (url: string) => ({
        valid: true as const, originalUrl: url,
        resolvedUrl: "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=Code",
        placeId: "1962086868" as const
      }))
    };
    const message = { edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
    const channel = {
      isTextBased: () => true, isDMBased: () => false,
      send: vi.fn(async () => ({ id: `message-${Math.random()}` })),
      messages: { fetch: vi.fn(async () => message) }
    };
    const cooldowns = new HostCooldownRepository(database);
    const service = new LiveServerService(
      { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client,
      repository, config, () => currentTime, verifier, undefined, cooldowns
    );
    const created = await service.create("guild", "owner", "carmine", oldUrl);
    if (!created.ok) throw new Error(created.message);
    const originalCooldown = cooldowns.get("owner");

    currentTime += 60 * 60 * 1_000;
    expect((await service.changeUrl(created.listing.id, "owner", newUrl)).ok).toBe(true);
    expect(cooldowns.get("owner")).toEqual(originalCooldown);

    currentTime = created.listing.expiresAt - 9 * 60 * 1_000;
    expect((await service.extend(created.listing.id, "owner")).ok).toBe(true);
    expect(cooldowns.get("owner")).toEqual(originalCooldown);
  });

  it("preserves the old URL, expiration, and active state when Change Link verification fails", async () => {
    const listing = repository.create({
      guildId: "guild", ownerId: "owner", type: "carmine", url: oldUrl,
      liveChannelId: "live", liveMessageId: "live-message", controlChannelId: "controls",
      controlMessageId: "control-message", createdAt: 1_800_000_000_000, expiresAt: 1_800_007_200_000
    });
    const verifier: PrivateServerVerifier = {
      verify: vi.fn(async () => ({ valid: false as const, reason: "wrong_place" as const, placeId: "123" }))
    };
    const fetchChannel = vi.fn();
    const client = { channels: { fetch: fetchChannel } } as unknown as Client;
    const service = new LiveServerService(client, repository, config, () => 1_800_000_100_000, verifier);

    const result = await service.changeUrl(listing.id, "owner", newUrl);
    const unchanged = repository.get(listing.id)!;

    expect(result).toEqual({ ok: false, message: "This private server is not for Tower of Hell." });
    expect(unchanged.url).toBe(oldUrl);
    expect(unchanged.expiresAt).toBe(listing.expiresAt);
    expect(unchanged.active).toBe(true);
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it("restores the canonical public message and Join Server button during restart reconciliation", async () => {
    const listing = repository.create({
      guildId: "guild", ownerId: "owner", type: "xp", url: oldUrl,
      liveChannelId: "live", liveMessageId: "live-message", controlChannelId: "controls",
      controlMessageId: "control-message", createdAt: 1_800_000_000_000, expiresAt: 1_800_007_200_000
    });
    const edit = vi.fn(async (_payload: unknown) => undefined);
    const fetchMessage = vi.fn(async (_id: string) => ({ edit }));
    const channel = {
      isTextBased: () => true,
      isDMBased: () => false,
      messages: { fetch: fetchMessage }
    };
    const client = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
    const verifier: PrivateServerVerifier = {
      verify: vi.fn(async () => ({ valid: false as const, reason: "unresolved" as const }))
    };
    const moderation = new ModerationRepository(database);
    for (let index = 1; index <= 6; index += 1) {
      moderation.submitReport(listing, `reporter-${index}`, "staff", listing.createdAt + index);
    }
    const service = new LiveServerService(client, repository, config, () => 1_800_000_100_000, verifier, moderation);

    await service.reconcileActive();

    expect(fetchMessage).toHaveBeenCalledWith(listing.liveMessageId);
    expect(edit).toHaveBeenCalledOnce();
    const recoveredPayload = edit.mock.calls[0]?.[0];
    expect(JSON.stringify(recoveredPayload)).toBe(JSON.stringify(liveMessage(listing, config.xpRoleId, 6)));
    expect(JSON.stringify(recoveredPayload)).toContain('"title":"⚡ XP Grinding Server"');
    expect(JSON.stringify(recoveredPayload)).toContain('"value":"<@owner>"');
    expect(JSON.stringify(recoveredPayload)).toContain('"value":"<t:1800000000:t>"');
    expect(JSON.stringify(recoveredPayload)).toContain('"value":"<t:1800007200:R>"');
    expect(JSON.stringify(recoveredPayload)).toContain('"value":"⚠️ 6/7"');
    expect(JSON.stringify(recoveredPayload)).toContain('"label":"Join Server"');
    expect(JSON.stringify(recoveredPayload)).toContain('"style":5');
    expect(JSON.stringify(recoveredPayload)).toContain(oldUrl);
  });
});
