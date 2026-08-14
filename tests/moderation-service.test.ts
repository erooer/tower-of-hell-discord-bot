import type Database from "better-sqlite3";
import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { Listing } from "../src/live-servers/model.js";
import { LiveServerService } from "../src/live-servers/service.js";
import type { PrivateServerVerifier } from "../src/roblox/private-server-verifier.js";
import { ModerationService } from "../src/moderation/service.js";
import type { StaffActor } from "../src/moderation/model.js";
import { openDatabase } from "../src/storage/database.js";
import { ListingRepository } from "../src/storage/listing-repository.js";
import { ModerationRepository } from "../src/storage/moderation-repository.js";

const config: Config = {
  token: "token", clientId: "client", guildId: "guild", liveChannelId: "live",
  commandsChannelId: "commands", carmineRoleId: "carmine-role", xpRoleId: "xp-role", eventRoleId: "event-role",
  staffReportsChannelId: "staff", sessionLogsChannelId: "logs", moderatorRoleId: "moderator-role",
  databasePath: ":memory:", expirationPollMs: 15_000
};
const now = 1_800_000_000_000;
const authorized: StaffActor = {
  userId: "moderator", guildId: "guild", channelId: "staff", roleIds: ["moderator-role"]
};

describe("ModerationService", () => {
  let database: Database.Database;
  let listings: ListingRepository;
  let repository: ModerationRepository;
  let listing: Listing;
  let send: ReturnType<typeof vi.fn>;
  let edit: ReturnType<typeof vi.fn>;
  let fetchMessage: ReturnType<typeof vi.fn>;
  let client: Client;
  let moderationEnd: ReturnType<typeof vi.fn>;
  let refreshLiveAnnouncement: ReturnType<typeof vi.fn>;
  let service: ModerationService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    listings = new ListingRepository(database);
    repository = new ModerationRepository(database);
    listing = listings.create({
      guildId: "guild", ownerId: "host", type: "xp",
      url: "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=ValidCode123",
      liveChannelId: "live", liveMessageId: "live-message", controlChannelId: "commands",
      controlMessageId: "control-message", createdAt: now, expiresAt: now + 7_200_000
    });
    edit = vi.fn(async (_payload: unknown) => undefined);
    fetchMessage = vi.fn(async (_id: string) => ({ edit }));
    send = vi.fn(async (payload: unknown) => ({
      id: JSON.stringify(payload).includes("Urgent Report") ? "urgent-message" : "staff-message"
    }));
    const channel = { isTextBased: () => true, isDMBased: () => false, send, messages: { fetch: fetchMessage } };
    client = { channels: { fetch: vi.fn(async () => channel) } } as unknown as Client;
    moderationEnd = vi.fn(async () => listing);
    refreshLiveAnnouncement = vi.fn(async () => undefined);
    const liveServers = { moderationEnd, refreshLiveAnnouncement } as unknown as LiveServerService;
    service = new ModerationService(client, listings, repository, liveServers, config, () => now + 1_000);
  });
  afterEach(() => database.close());

  async function reportSeven(): Promise<void> {
    for (let index = 1; index <= 7; index += 1) {
      const result = await service.report(listing.id, `reporter-${index}`, "guild", "server_missing", "");
      expect(result.ok).toBe(true);
    }
  }

  it("opening eligibility is read-only and completed submissions persist every supported reason", async () => {
    expect(service.checkReportEligibility(listing.id, "candidate", "guild")).toEqual({
      ok: true, message: "Eligible to report."
    });
    expect(repository.getReportCount(listing.id)).toBe(0);
    expect(refreshLiveAnnouncement).not.toHaveBeenCalled();

    const submissions = [
      ["user-host", "host_not_in_server", ""],
      ["user-missing", "server_missing", ""],
      ["user-category", "wrong_category", "Optional context"],
      ["user-other", "other", "Host keeps posting an expired link"]
    ] as const;
    for (const [userId, reason, details] of submissions) {
      expect((await service.report(listing.id, userId, "guild", reason, details)).ok).toBe(true);
    }
    expect(repository.getReporterSummaries(listing.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "user-host", reason: "host_not_in_server", details: null }),
      expect.objectContaining({ userId: "user-missing", reason: "server_missing", details: null }),
      expect.objectContaining({ userId: "user-category", reason: "wrong_category", details: "Optional context" }),
      expect.objectContaining({ userId: "user-other", reason: "other", details: "Host keeps posting an expired link" })
    ]));
    expect(refreshLiveAnnouncement).toHaveBeenCalledTimes(4);
  });

  it("rejects forged reasons, missing Other details, and oversized details without counting", async () => {
    expect(await service.report(listing.id, "forged", "guild", "made_up", "details")).toEqual({
      ok: false, message: "Select a valid report reason."
    });
    expect(await service.report(listing.id, "other-empty", "guild", "other", "   ")).toEqual({
      ok: false, message: "Additional details are required when selecting Other."
    });
    expect(await service.report(listing.id, "too-long", "guild", "server_missing", "x".repeat(301))).toEqual({
      ok: false, message: "Additional details must be 300 characters or fewer."
    });
    expect(repository.getReportCount(listing.id)).toBe(0);
    expect(refreshLiveAnnouncement).not.toHaveBeenCalled();
  });

  it("updates the public counter after accepted reports one through eight without capping at seven", async () => {
    const verifier: PrivateServerVerifier = { verify: vi.fn() };
    const liveService = new LiveServerService(client, listings, config, () => now + 1_000, verifier, repository);
    const integrated = new ModerationService(client, listings, repository, liveService, config, () => now + 1_000);

    for (let index = 1; index <= 8; index += 1) {
      expect((await integrated.report(listing.id, `counter-${index}`, "guild", "server_missing", "")).ok).toBe(true);
    }

    const publicPayloads = edit.mock.calls
      .map((call) => JSON.stringify(call[0]))
      .filter((payload) => payload.includes('"title":"⚡ XP Grinding Server"'));
    expect(publicPayloads).toHaveLength(8);
    expect(publicPayloads[0]).toContain('"value":"⚠️ 1/7"');
    expect(publicPayloads[5]).toContain('"value":"⚠️ 6/7"');
    expect(publicPayloads[6]).toContain('"value":"⚠️ 7/7"');
    expect(publicPayloads[7]).toContain('"value":"⚠️ 8/7"');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("creates one quiet normal panel at report one and one pinging urgent panel at report seven", async () => {
    for (let index = 1; index <= 6; index += 1) {
      await service.report(listing.id, `reporter-${index}`, "guild", "server_missing", "");
    }
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      content: "",
      allowedMentions: { roles: [], users: [], repliedUser: false }
    });
    expect(JSON.stringify(send.mock.calls[0]?.[0])).toContain("⚠️ Reported Session");
    expect(JSON.stringify(edit.mock.calls.at(-1)?.[0])).toContain('"value":"6/7"');

    await service.report(listing.id, "reporter-7", "guild", "host_not_in_server", "");
    expect(send).toHaveBeenCalledTimes(2);
    expect(repository.getCase(listing.id)?.staffMessageId).toBe("staff-message");
    expect(repository.getCase(listing.id)?.urgentMessageId).toBe("urgent-message");
    expect(JSON.stringify(send.mock.calls[1]?.[0])).toContain("🚨 Urgent Report");
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      content: "<@&moderator-role>",
      allowedMentions: { roles: ["moderator-role"], users: [], repliedUser: false }
    });
    expect(JSON.stringify(send.mock.calls[1]?.[0])).toContain("Server doesn't exist — 6");
    expect(JSON.stringify(send.mock.calls[1]?.[0])).toContain("Host is not in the server — 1");
    expect(edit.mock.calls.map((call) => JSON.stringify(call[0])).some((payload) =>
      payload.includes("Reported Session") && payload.includes('"value":"7/7"')
    )).toBe(true);

    await service.report(listing.id, "reporter-8", "guild", "wrong_category", "");
    expect(send).toHaveBeenCalledTimes(2);
    expect(fetchMessage).toHaveBeenCalledWith("urgent-message");
    expect(repository.getReportCount(listing.id)).toBe(8);
    const urgentRefresh = edit.mock.calls.map((call) => JSON.stringify(call[0])).find((payload) => payload.includes("Urgent Report") && payload.includes('"value":"8/7"'));
    expect(urgentRefresh).toContain("Incorrect category of grind — 1");
    expect(urgentRefresh).toContain('"roles":[]');
  });

  it("returns duplicate and blacklist messages without changing the count", async () => {
    expect((await service.report(listing.id, "reporter", "guild", "server_missing", "")).message).toContain("1 unique report");
    expect(await service.report(listing.id, "reporter", "guild", "wrong_category", "")).toEqual({
      ok: false, message: "You have already reported this server."
    });
    expect(service.checkReportEligibility(listing.id, "reporter", "guild").message)
      .toBe("You have already reported this server.");
    repository.blacklistReporter("troll", "moderator", null, now);
    expect(await service.report(listing.id, "troll", "guild", "server_missing", "")).toEqual({
      ok: false, message: "You've been blacklisted from reporting. Contact a moderator to appeal."
    });
    expect(service.checkReportEligibility(listing.id, "troll", "guild").message)
      .toBe("You've been blacklisted from reporting. Contact a moderator to appeal.");
    expect(repository.getReportCount(listing.id)).toBe(1);
    expect(refreshLiveAnnouncement).toHaveBeenCalledOnce();
  });

  it("view reporters returns unique histories and supports safe target blacklisting", async () => {
    await reportSeven();
    const view = await service.viewReporters(listing.id, authorized);
    expect(view.ok).toBe(true);
    expect(view.reporters).toHaveLength(7);
    expect(view.reporters?.[0]).toMatchObject({ userId: "reporter-1", total: 1, valid: 0, rejected: 0 });
    expect(JSON.stringify(view.reportersPayload)).toContain(`lsmod:blacklist:${listing.id}`);

    expect(await service.blacklistReporter(listing.id, "not-a-reporter", authorized)).toEqual({
      ok: false, message: "That user is not a reporter on this moderation case."
    });
    expect((await service.blacklistReporter(listing.id, "reporter-1", authorized)).ok).toBe(true);
    expect(repository.isReporterBlacklisted("reporter-1")).toBe(true);
    expect((await service.blacklistReporter(listing.id, "reporter-1", authorized)).message).toBe("That reporter is already blacklisted.");
  });

  it("rejects every staff action from an unauthorized actor", async () => {
    await reportSeven();
    const unauthorized: StaffActor = { userId: "user", guildId: "guild", channelId: "staff", roleIds: [] };
    expect((await service.viewReporters(listing.id, unauthorized)).message).toBe("You are not authorized to use moderation controls.");
    expect((await service.blacklistReporter(listing.id, "reporter-1", unauthorized)).message).toBe("You are not authorized to use moderation controls.");
    expect((await service.resolve(listing.id, "strike", unauthorized)).message).toBe("You are not authorized to use moderation controls.");
    expect(repository.getCase(listing.id)?.status).toBe("open");
    expect(moderationEnd).not.toHaveBeenCalled();
  });

  it("strike updates history and disables both staff panels", async () => {
    await reportSeven();
    edit.mockClear();
    expect((await service.resolve(listing.id, "strike", authorized)).ok).toBe(true);
    expect(repository.reporterHistory("reporter-1")).toEqual({ total: 1, valid: 1, rejected: 0 });
    expect(repository.getHostStrikeCount("host")).toBe(1);
    expect(moderationEnd).toHaveBeenCalledOnce();
    const resolvedPanels = edit.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(resolvedPanels.some((payload) => payload.includes("Reported Session") && payload.includes('"disabled":true'))).toBe(true);
    expect(resolvedPanels.some((payload) => payload.includes("Urgent Report") && payload.includes('"disabled":true'))).toBe(true);
    expect((await service.resolve(listing.id, "ignore", authorized)).message).toBe("This moderation case has already been resolved.");
    expect(repository.getHostStrikeCount("host")).toBe(1);
  });

  it("Ignore Reports resolves and disables both staff panels", async () => {
    await reportSeven();
    edit.mockClear();
    expect((await service.resolve(listing.id, "ignore", authorized)).ok).toBe(true);
    const resolvedPanels = edit.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(resolvedPanels.some((payload) => payload.includes("Reported Session") && payload.includes('"disabled":true'))).toBe(true);
    expect(resolvedPanels.some((payload) => payload.includes("Urgent Report") && payload.includes('"disabled":true'))).toBe(true);
    expect(repository.reporterHistory("reporter-1")).toEqual({ total: 1, valid: 0, rejected: 1 });
    expect(moderationEnd).not.toHaveBeenCalled();
  });

  it("restart reconciliation edits an existing case and never duplicates the staff message", async () => {
    await reportSeven();
    send.mockClear();
    edit.mockClear();
    await service.reconcileCases();
    expect(send).not.toHaveBeenCalled();
    expect(fetchMessage).toHaveBeenCalledWith("staff-message");
    expect(fetchMessage).toHaveBeenCalledWith("urgent-message");
    expect(edit).toHaveBeenCalledTimes(2);
    expect(repository.getCase(listing.id)).toMatchObject({
      staffMessageId: "staff-message", urgentMessageId: "urgent-message"
    });
    const urgentRefresh = edit.mock.calls.map((call) => JSON.stringify(call[0])).find((payload) => payload.includes("Urgent Report"));
    expect(urgentRefresh).toContain('"roles":[]');
  });

  it("keeps reporting controls and case state intact through Change Link and extension edits", async () => {
    await reportSeven();
    const replacementUrl = "https://www.roblox.com/share?code=Replacement123&type=Server";
    const verifier: PrivateServerVerifier = {
      verify: vi.fn(async () => ({
        valid: true as const,
        originalUrl: replacementUrl,
        resolvedUrl: "https://www.roblox.com/share-links?code=Replacement123&type=Server",
        placeId: "1962086868" as const
      }))
    };
    const actionNow = () => listing.expiresAt - 5 * 60_000;
    const liveService = new LiveServerService(client, listings, config, actionNow, verifier, repository);
    const integratedModeration = new ModerationService(client, listings, repository, liveService, config, actionNow);

    edit.mockClear();
    fetchMessage.mockClear();

    expect((await liveService.changeUrl(listing.id, "host", replacementUrl)).ok).toBe(true);
    await integratedModeration.refreshCase(listing.id);
    const beforeExtension = listings.get(listing.id)!;
    expect((await liveService.extend(listing.id, "host")).ok).toBe(true);
    await integratedModeration.refreshCase(listing.id);
    const afterExtension = listings.get(listing.id)!;

    expect(afterExtension.url).toBe(replacementUrl);
    expect(afterExtension.expiresAt).toBe(beforeExtension.expiresAt + 3_600_000);
    expect(repository.getReportCount(listing.id)).toBe(7);
    expect(repository.listCases()).toHaveLength(1);
    const editedPayloads = edit.mock.calls.map((call) => JSON.stringify(call[0]));
    expect(editedPayloads.some((payload) => payload.includes(`lsreport:submit:${listing.id}`))).toBe(true);
    expect(editedPayloads.some((payload) => payload.includes(replacementUrl))).toBe(true);
    const publicPayloads = editedPayloads.filter((payload) => payload.includes('"value":"⚠️ 7/7"'));
    expect(publicPayloads).toHaveLength(2);
    expect(publicPayloads.every((payload) => payload.includes('"value":"⚠️ 7/7"'))).toBe(true);
  });

  it("a host blacklisted at three strikes is rejected before URL verification or Discord publishing", async () => {
    for (let strike = 1; strike <= 3; strike += 1) {
      const session = strike === 1 ? listing : listings.create({
        guildId: `guild-${strike}`,
        ownerId: listing.ownerId,
        type: listing.type,
        url: listing.url,
        liveChannelId: listing.liveChannelId,
        liveMessageId: `live-${strike}`,
        controlChannelId: listing.controlChannelId,
        controlMessageId: `control-${strike}`,
        createdAt: now + strike,
        expiresAt: now + 7_200_000
      });
      for (let reporter = 1; reporter <= 7; reporter += 1) {
        repository.submitReport(session, `s${strike}-r${reporter}`, "staff", now + reporter);
      }
      repository.resolveCase(session.id, "strike", "moderator", now + 100 + strike);
    }
    const verifier: PrivateServerVerifier = { verify: vi.fn() };
    const noDiscordClient = { channels: { fetch: vi.fn() } } as unknown as Client;
    const liveService = new LiveServerService(noDiscordClient, listings, config, () => now, verifier, repository);
    const result = await liveService.create("new-guild", "host", "carmine", listing.url);
    expect(result).toEqual({
      ok: false,
      message: "You are blacklisted from creating live-server announcements. Contact a moderator to appeal."
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});
