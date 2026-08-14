import { describe, expect, it } from "vitest";
import type { Listing } from "../src/live-servers/model.js";
import { reportersReply, staffCaseMessage } from "../src/moderation/messages.js";
import type { CaseSnapshot, ModerationCase } from "../src/moderation/model.js";

const listing: Listing = {
  id: "session-id", guildId: "guild", ownerId: "host-id", type: "carmine",
  url: "https://www.roblox.com/share?code=ValidCode123&type=Server",
  liveChannelId: "live", liveMessageId: "live-message", controlChannelId: "commands",
  controlMessageId: "control-message", createdAt: 1_800_000_000_000,
  expiresAt: 1_800_007_200_000, active: true, cleanupPending: false,
  endedAt: null, endedReason: null, updatedAt: 1_800_000_000_000
};
const moderationCase: ModerationCase = {
  sessionId: listing.id, staffChannelId: "staff", staffMessageId: "staff-message",
  escalatedAt: 1_800_000_100_000, status: "open", resolvedBy: null,
  resolvedAt: null, updatedAt: 1_800_000_100_000
};

describe("moderation message builders", () => {
  it("shows the required staff case facts and controls without reporter names", () => {
    const snapshot: CaseSnapshot = {
      case: moderationCase, listing, reportCount: 7, hostStrikeCount: 2,
      reasonCounts: [
        { reason: "host_not_in_server", count: 4 },
        { reason: "server_missing", count: 2 },
        { reason: "wrong_category", count: 1 }
      ]
    };
    const payload = staffCaseMessage(snapshot, "moderator-role");
    const json = JSON.stringify(payload);
    expect(payload.content).toBe("<@&moderator-role>");
    expect(payload.allowedMentions).toEqual({ roles: ["moderator-role"], users: [], repliedUser: false });
    expect(json).toContain("🔥 Carmine Hunting");
    expect(json).toContain("<@host-id>");
    expect(json).toContain("<t:1800000000:f>");
    expect(json).toContain("<t:1800007200:R>");
    expect(json).toContain('"name":"Unique Reports","value":"7"');
    expect(json).toContain('"name":"Existing Valid Strikes","value":"2"');
    expect(json).toContain("Host is not in the server — 4");
    expect(json).toContain("Server doesn't exist — 2");
    expect(json).toContain(listing.url);
    expect(json).toContain("View Reporters");
    expect(json).toContain("Ignore Reports");
    expect(json).toContain("Strike / Remove");
  });

  it("disables staff controls after resolution", () => {
    const payload = staffCaseMessage({
      case: { ...moderationCase, status: "ignored", resolvedBy: "moderator", resolvedAt: 1_800_000_200_000 },
      listing, reportCount: 8, hostStrikeCount: 0, reasonCounts: [{ reason: null, count: 8 }]
    }, "moderator-role");
    expect(JSON.stringify(payload.components).match(/"disabled":true/g)).toHaveLength(4);
  });

  it("builds an ephemeral-compatible reporter history and blacklist selector", () => {
    const payload = reportersReply("session-id", [
      { userId: "user-1", reportedAt: 1, total: 8, valid: 5, rejected: 3, reason: "server_missing", details: null },
      { userId: "user-2", reportedAt: 2, total: 2, valid: 0, rejected: 1, reason: "other", details: "Expired link" }
    ]);
    expect(payload.content).toContain("<@user-1> (`user-1`) — Server doesn't exist");
    expect(payload.content).toContain("History: 8 total | 5 valid | 3 rejected");
    expect(payload.content).toContain("Other: Expired link");
    expect(payload.allowedMentions).toEqual({ users: [], roles: [], repliedUser: false });
    expect(JSON.stringify(payload.components)).toContain("lsmod:blacklist:session-id");
    expect(JSON.stringify(payload.components)).toContain('"value":"user-1"');
  });
});
