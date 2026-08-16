import { describe, expect, it } from "vitest";
import type { Listing } from "../src/live-servers/model.js";
import { reportersReply, staffCaseMessage, urgentCaseMessage } from "../src/moderation/messages.js";
import type { CaseSnapshot, ModerationCase } from "../src/moderation/model.js";

const listing: Listing = {
  id: "session-id", guildId: "guild", ownerId: "host-id", type: "carmine",
  hostSource: "self", hostMessage: null,
  url: "https://www.roblox.com/share?code=ValidCode123&type=Server",
  liveChannelId: "live", liveMessageId: "live-message", threadId: null, controlChannelId: "commands",
  controlMessageId: "control-message", createdAt: 1_800_000_000_000,
  expiresAt: 1_800_007_200_000, active: true, cleanupPending: false,
  endedAt: null, endedReason: null, updatedAt: 1_800_000_000_000
};
const moderationCase: ModerationCase = {
  sessionId: listing.id, staffChannelId: "staff", staffMessageId: "staff-message",
  urgentMessageId: "urgent-message", urgentEscalatedAt: 1_800_000_100_000,
  urgentPingedAt: 1_800_000_100_000,
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
    const payload = staffCaseMessage(snapshot);
    const json = JSON.stringify(payload);
    expect(payload.content).toBe("");
    expect(payload.allowedMentions).toEqual({ roles: [], users: [], repliedUser: false });
    expect(json).toContain("⚠️ Reported Session");
    expect(json).toContain("🔥 Carmine Hunting");
    expect(json).toContain("<@host-id>");
    expect(json).toContain("<t:1800000000:f>");
    expect(json).toContain("<t:1800007200:R>");
    expect(json).toContain('"name":"Reports","value":"7/7"');
    expect(json).toContain('"name":"Existing Valid Strikes","value":"2"');
    expect(json).toContain("Host is not in the server — 4");
    expect(json).toContain("Server doesn't exist — 2");
    expect(json).toContain(listing.url);
    expect(json).toContain("View Reporters");
    expect(json).toContain("Ignore Reports");
    expect(json).toContain("Strike / Remove");
  });

  it("builds a distinct urgent panel and only enables the role mention for the initial ping", () => {
    const snapshot: CaseSnapshot = {
      case: moderationCase, listing, reportCount: 8, hostStrikeCount: 2,
      reasonCounts: [{ reason: "server_missing", count: 8 }]
    };
    const initial = urgentCaseMessage(snapshot, "moderator-role", true);
    const refresh = urgentCaseMessage(snapshot, "moderator-role", false);
    expect(initial.content).toBe("<@&moderator-role>");
    expect(initial.allowedMentions).toEqual({ roles: ["moderator-role"], users: [], repliedUser: false });
    expect(JSON.stringify(initial)).toContain("🚨 Urgent Report");
    expect(JSON.stringify(initial)).toContain('"name":"Reports","value":"8/7"');
    expect(JSON.stringify(initial)).toContain(`Session ${listing.id}`);
    expect(refresh.content).toBe("<@&moderator-role>");
    expect(refresh.allowedMentions).toEqual({ roles: [], users: [], repliedUser: false });
  });

  it("disables staff controls after resolution", () => {
    const snapshot = {
      case: { ...moderationCase, status: "ignored", resolvedBy: "moderator", resolvedAt: 1_800_000_200_000 },
      listing, reportCount: 8, hostStrikeCount: 0, reasonCounts: [{ reason: null, count: 8 }]
    } satisfies CaseSnapshot;
    expect(JSON.stringify(staffCaseMessage(snapshot).components).match(/"disabled":true/g)).toHaveLength(4);
    expect(JSON.stringify(urgentCaseMessage(snapshot, "moderator-role", false).components).match(/"disabled":true/g)).toHaveLength(4);
  });

  it("preserves Event as the activity type in moderation panels", () => {
    const snapshot: CaseSnapshot = {
      case: moderationCase, listing: { ...listing, type: "event" }, reportCount: 1,
      hostStrikeCount: 0, reasonCounts: [{ reason: "other", count: 1 }]
    };
    const json = JSON.stringify(staffCaseMessage(snapshot));
    expect(json).toContain('"name":"Activity","value":"Event"');
    expect(json).not.toContain("XP Grinding");
    expect(json).not.toContain("Carmine Hunting");
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
