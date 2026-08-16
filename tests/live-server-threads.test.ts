import type Database from "better-sqlite3";
import { DiscordAPIError, type Client } from "discord.js";
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
  let fetchChannel: ReturnType<typeof vi.fn>;
  let thread: any;
  let threadMissing: boolean;
  let threadFetchFailure: unknown | null;
  let client: Client;
  let service: LiveServerService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    repository = new ListingRepository(database);
    currentTime = 1_800_000_000_000;
    moderatorPresent = false;
    threadMissing = false;
    threadFetchFailure = null;
    threadSend = vi.fn(async () => ({ id: "thread-opening" }));
    thread = {
      id: "thread-id", archived: false, locked: false, isThread: () => true, send: threadSend
    };
    setArchived = vi.fn(async (archived = true) => { thread.archived = archived; return thread; });
    setLocked = vi.fn(async (locked = true) => { thread.locked = locked; return thread; });
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
    fetchChannel = vi.fn(async (id: string) => {
        if (id === config.liveChannelId) return liveChannel;
        if (id === config.commandsChannelId) return controlChannel;
        if (id === thread.id) {
          if (threadFetchFailure) throw threadFetchFailure;
          return threadMissing ? null : thread;
        }
        return null;
      });
    client = {
      channels: { fetch: fetchChannel },
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
    expect(setLocked).toHaveBeenCalledWith(true, "Live-server session ended");
    expect(setArchived).toHaveBeenCalledWith(true, "Live-server session ended");
    expect(setLocked.mock.invocationCallOrder[0]).toBeLessThan(setArchived.mock.invocationCallOrder[0]!);
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
    setLocked.mockRejectedValueOnce(new Error("Temporary Discord failure"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await service.end(listing.id, "host")).ok).toBe(true);
    expect(repository.get(listing.id)?.cleanupPending).toBe(true);
    await service.expireDue();
    expect(setLocked).toHaveBeenCalledTimes(2);
    expect(setArchived).toHaveBeenCalledOnce();
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

  it("archives an open thread that is already locked without another lock request", async () => {
    const listing = await create();
    thread.locked = true;
    await service.end(listing.id, "host");
    expect(setLocked).not.toHaveBeenCalled();
    expect(setArchived).toHaveBeenCalledTimes(1);
    expect(thread).toMatchObject({ archived: true, locked: true });
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);
  });

  it("treats an already archived and locked thread as closed without editing it", async () => {
    const listing = await create();
    thread.archived = true;
    thread.locked = true;
    await service.end(listing.id, "host");
    expect(fetchChannel).toHaveBeenCalledWith("thread-id", { force: true });
    expect(setArchived).not.toHaveBeenCalled();
    expect(setLocked).not.toHaveBeenCalled();
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);
  });

  it("temporarily reopens an archived unlocked thread, locks it, and archives it again", async () => {
    const listing = await create();
    thread.archived = true;
    thread.locked = false;
    await service.end(listing.id, "host");
    expect(setArchived.mock.calls.map(([archived]) => archived)).toEqual([false, true]);
    expect(setLocked).toHaveBeenCalledWith(true, "Live-server session ended");
    expect(thread).toMatchObject({ archived: true, locked: true });
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);

    await service.expireDue();
    expect(setArchived).toHaveBeenCalledTimes(2);
    expect(setLocked).toHaveBeenCalledOnce();
  });

  it("refreshes and recovers when Discord reports that the thread became archived", async () => {
    const listing = await create();
    setLocked.mockImplementationOnce(async () => {
      thread.archived = true;
      throw discordApiError(50083, "Thread is archived");
    });
    await service.end(listing.id, "host");
    expect(fetchChannel.mock.calls.filter(([id]) => id === "thread-id")).toHaveLength(2);
    expect(setArchived.mock.calls.map(([archived]) => archived)).toEqual([false, true]);
    expect(setLocked).toHaveBeenCalledTimes(2);
    expect(thread).toMatchObject({ archived: true, locked: true });
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);
  });

  it.each([
    ["a missing thread", null],
    ["Discord Unknown Channel", discordApiError(10003, "Unknown Channel")]
  ])("treats %s as already cleaned", async (_description, fetchFailure) => {
    const listing = await create();
    if (fetchFailure) threadFetchFailure = fetchFailure;
    else threadMissing = true;
    await service.end(listing.id, "host");
    expect(setArchived).not.toHaveBeenCalled();
    expect(setLocked).not.toHaveBeenCalled();
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);
    await service.expireDue();
    expect(fetchChannel.mock.calls.filter(([id]) => id === "thread-id")).toHaveLength(1);
  });

  it("does not retry thread cleanup after automatic expiration succeeds", async () => {
    const listing = await create();
    currentTime = listing.expiresAt;
    await service.expireDue();
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);
    expect(setLocked).toHaveBeenCalledOnce();
    expect(setArchived).toHaveBeenCalledOnce();
    await service.expireDue();
    expect(setLocked).toHaveBeenCalledOnce();
    expect(setArchived).toHaveBeenCalledOnce();
  });

  it("does not retry an already closed thread after restart reconciliation", async () => {
    const listing = await create();
    repository.deactivate(listing.id, "owner_ended", currentTime + 1);
    thread.archived = true;
    thread.locked = true;
    const restarted = new LiveServerService(client, repository, config, () => currentTime + 1, { verify: vi.fn() });
    await restarted.reconcileActive();
    expect(repository.get(listing.id)?.cleanupPending).toBe(false);
    expect(setArchived).not.toHaveBeenCalled();
    expect(setLocked).not.toHaveBeenCalled();
    const threadFetches = fetchChannel.mock.calls.filter(([id]) => id === "thread-id").length;
    await restarted.reconcileActive();
    expect(fetchChannel.mock.calls.filter(([id]) => id === "thread-id")).toHaveLength(threadFetches);
  });

  it("does not create threads merely because an unrelated live-channel message is sent", async () => {
    await liveSend({ content: "Unrelated message" });
    expect(startThread).not.toHaveBeenCalled();
    expect(repository.listActive()).toEqual([]);
  });
});

function discordApiError(code: number, message: string): DiscordAPIError {
  return new DiscordAPIError(
    { code, message }, code, 400, "PATCH", "https://discord.test/channels/thread-id",
    { body: null, files: [] }
  );
}
