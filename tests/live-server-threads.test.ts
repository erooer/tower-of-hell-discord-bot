import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { LiveServerService } from "../src/live-servers/service.js";
import type { PrivateServerVerifier } from "../src/roblox/private-server-verifier.js";
import { openDatabase } from "../src/storage/database.js";
import { ListingRepository } from "../src/storage/listing-repository.js";

const config: Config = {
  token: "token", clientId: "client", guildId: "guild", liveChannelId: "live",
  commandsChannelId: "controls", carmineRoleId: "carmine-role", xpRoleId: "xp-role", eventRoleId: "event-role",
  staffReportsChannelId: "staff", sessionLogsChannelId: "logs", moderatorRoleId: "moderator-role",
  databasePath: ":memory:", expirationPollMs: 15_000
};
const url = "https://www.roblox.com/share?code=ValidCode123&type=Server";
const openingMessage = "Use this thread to coordinate with the host and other players in this session.";

describe("live-session announcement threads", () => {
  let database: Database.Database;
  let repository: ListingRepository;
  let currentTime: number;
  let moderatorPresent: boolean;
  let startThread: ReturnType<typeof vi.fn>;
  let threadSend: ReturnType<typeof vi.fn>;
  let setArchived: ReturnType<typeof vi.fn>;
  let setLocked: ReturnType<typeof vi.fn>;
  let liveSend: ReturnType<typeof vi.fn>;
  let liveEdit: ReturnType<typeof vi.fn>;
  let controlEdit: ReturnType<typeof vi.fn>;
  let thread: any;
  let client: Client;
  let service: LiveServerService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    repository = new ListingRepository(database);
    currentTime = 1_800_000_000_000;
    moderatorPresent = false;
    threadSend = vi.fn(async () => ({ id: "thread-opening" }));
    thread = {
      id: "thread-id", archived: false, locked: false, isThread: () => true, send: threadSend
    };
    setArchived = vi.fn(async () => { thread.archived = true; return thread; });
    setLocked = vi.fn(async () => { thread.locked = true; return thread; });
    thread.setArchived = setArchived;
    thread.setLocked = setLocked;
    startThread = vi.fn(async () => thread);
    liveEdit = vi.fn(async () => undefined);
    controlEdit = vi.fn(async () => undefined);
    const liveMessage = {
      id: "live-message", startThread, edit: liveEdit, delete: vi.fn(async () => undefined)
    };
    const controlMessage = {
      id: "control-message", edit: controlEdit, delete: vi.fn(async () => undefined)
    };
    liveSend = vi.fn(async () => liveMessage);
    const liveChannel = {
      isTextBased: () => true, isDMBased: () => false, send: liveSend,
      messages: { fetch: vi.fn(async () => liveMessage) }
    };
    const controlChannel = {
      isTextBased: () => true, isDMBased: () => false,
      send: vi.fn(async () => controlMessage), messages: { fetch: vi.fn(async () => controlMessage) }
    };
    client = {
      channels: { fetch: vi.fn(async (id: string) => {
        if (id === config.liveChannelId) return liveChannel;
        if (id === config.commandsChannelId) return controlChannel;
        if (id === thread.id) return thread;
        return null;
      }) },
      guilds: { fetch: vi.fn(async () => ({ members: { fetch: vi.fn(async () => ({
        roles: { cache: { has: (roleId: string) => moderatorPresent && roleId === config.moderatorRoleId } }
      })) } })) }
    } as unknown as Client;
    const verifier: PrivateServerVerifier = { verify: vi.fn(async (input: string) => ({
      valid: true as const, originalUrl: input,
      resolvedUrl: "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=ValidCode123",
      placeId: "1962086868" as const
    })) };
    service = new LiveServerService(client, repository, config, () => currentTime, verifier);
  });

  afterEach(() => database.close());

  async function create(type: "carmine" | "xp" | "event" = "xp") {
    const result = await service.create("guild", "host", type, url);
    if (!result.ok) throw new Error(result.message);
    return result.listing;
  }

  it.each([
    ["carmine", "Carmine Hunt"],
    ["xp", "XP Grinding"],
    ["event", "Event"]
  ] as const)("creates one attached thread for a %s announcement", async (type, name) => {
    const listing = await create(type);
    expect(startThread).toHaveBeenCalledOnce();
    expect(startThread).toHaveBeenCalledWith({ name });
    expect(threadSend).toHaveBeenCalledWith({
      content: openingMessage,
      allowedMentions: { users: [], roles: [], repliedUser: false }
    });
    expect(listing.threadId).toBe("thread-id");
    expect(repository.get(listing.id)?.threadId).toBe("thread-id");
  });

  it("does not create another thread for Change Link, extension, or restart reconciliation", async () => {
    const listing = await create();
    expect((await service.changeUrl(listing.id, "host", `${url}&changed=1`)).ok).toBe(true);
    currentTime = listing.expiresAt - 30 * 60_000;
    expect((await service.extend(listing.id, "host")).ok).toBe(true);
    const restarted = new LiveServerService(client, repository, config, () => currentTime, {
      verify: vi.fn()
    });
    await restarted.reconcileActive();
    expect(startThread).toHaveBeenCalledOnce();
    expect(repository.get(listing.id)?.threadId).toBe("thread-id");
  });

  it("archives and locks the thread when the host manually ends the session", async () => {
    const listing = await create("carmine");
    expect((await service.end(listing.id, "host")).ok).toBe(true);
    expect(setArchived).toHaveBeenCalledWith(true, "Live-server session ended");
    expect(setLocked).toHaveBeenCalledWith(true, "Live-server session ended");
  });

  it("archives and locks the thread when a moderator ends another host's session", async () => {
    const listing = await create("event");
    moderatorPresent = true;
    expect((await service.end(listing.id, "moderator")).ok).toBe(true);
    expect(setArchived).toHaveBeenCalledOnce();
    expect(setLocked).toHaveBeenCalledOnce();
  });

  it("archives and locks the thread when Strike / Remove ends the session", async () => {
    const listing = await create("xp");
    expect(await service.moderationEnd(listing.id, "moderator")).toMatchObject({ active: false });
    expect(setArchived).toHaveBeenCalledOnce();
    expect(setLocked).toHaveBeenCalledOnce();
  });

  it("archives and locks the thread on automatic expiration", async () => {
    const listing = await create();
    currentTime = listing.expiresAt;
    await service.expire(listing.id);
    expect(setArchived).toHaveBeenCalledOnce();
    expect(setLocked).toHaveBeenCalledOnce();
  });

  it("does not fail hosting when thread creation fails", async () => {
    startThread.mockRejectedValue(new Error("Missing Create Public Threads"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listing = await create();
    expect(listing.active).toBe(true);
    expect(listing.threadId).toBeNull();
    expect(liveSend).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("Failed to create live-session thread", listing.id, expect.any(Error));
    error.mockRestore();
  });

  it("keeps the persisted thread and active session when its opening message fails", async () => {
    threadSend.mockRejectedValue(new Error("Missing Send Messages in Threads"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listing = await create("event");
    expect(listing.active).toBe(true);
    expect(listing.threadId).toBe("thread-id");
    expect(error).toHaveBeenCalledWith(
      "Failed to send live-session thread opening message", listing.id, "thread-id", expect.any(Error)
    );
    error.mockRestore();
  });

  it("keeps session cleanup restart-safe when thread archive or lock initially fails", async () => {
    const listing = await create();
    setArchived.mockRejectedValueOnce(new Error("Missing Manage Threads"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await service.end(listing.id, "host")).ok).toBe(true);
    expect(repository.get(listing.id)?.cleanupPending).toBe(true);
    await service.expireDue();
    expect(setArchived).toHaveBeenCalledTimes(2);
    expect(setLocked).toHaveBeenCalledOnce();
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("closes a persisted ended session thread during restart reconciliation", async () => {
    const listing = await create();
    repository.deactivate(listing.id, "owner_ended", currentTime + 1);
    const restarted = new LiveServerService(client, repository, config, () => currentTime + 1, { verify: vi.fn() });
    await restarted.reconcileActive();
    expect(setArchived).toHaveBeenCalledOnce();
    expect(setLocked).toHaveBeenCalledOnce();
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);
    expect(startThread).toHaveBeenCalledOnce();
  });

  it("does not create threads merely because an unrelated live-channel message is sent", async () => {
    await liveSend({ content: "Unrelated message" });
    expect(startThread).not.toHaveBeenCalled();
    expect(repository.listActive()).toEqual([]);
  });
});
