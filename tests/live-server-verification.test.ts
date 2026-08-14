import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { LiveServerService } from "../src/live-servers/service.js";
import type { PrivateServerVerifier, RobloxVerificationResult } from "../src/roblox/private-server-verifier.js";
import { openDatabase } from "../src/storage/database.js";
import { ListingRepository } from "../src/storage/listing-repository.js";

const oldUrl = "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=OldCode12345";
const newUrl = "https://www.roblox.com/share?code=NewCode12345&type=Server";
const config: Config = {
  token: "token", clientId: "client", guildId: "guild", liveChannelId: "live",
  commandsChannelId: "controls", carmineRoleId: "carmine-role", xpRoleId: "xp-role",
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
});
