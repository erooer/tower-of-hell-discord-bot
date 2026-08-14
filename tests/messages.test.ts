import { describe, expect, it } from "vitest";
import { controlMessage, liveMessage } from "../src/live-servers/messages.js";
import type { Listing } from "../src/live-servers/model.js";

const listing: Listing = {
  id: "listing-id", guildId: "guild", ownerId: "12345678901234567", type: "carmine",
  url: "https://www.roblox.com/share?code=AbCdEfGh1234&type=Server",
  liveChannelId: "live", liveMessageId: "message", controlChannelId: "commands", controlMessageId: "panel",
  createdAt: 1_800_000_000_000, expiresAt: 1_800_007_200_000, active: true, cleanupPending: false,
  endedAt: null, endedReason: null, updatedAt: 1_800_000_000_000
};

describe("Discord message builders", () => {
  it("keeps live messages minimal and restricts allowed role mentions", () => {
    const message = liveMessage(listing, "98765432109876543");
    expect(message.content).toBe("<@&98765432109876543>");
    expect(message.allowedMentions).toEqual({ roles: ["98765432109876543"], users: [], repliedUser: false });
    expect(message.embeds).toHaveLength(1);
    expect(message.components).toEqual([]);
    expect(JSON.stringify(message.embeds?.[0])).toContain("<t:1800007200:R>");
  });

  it("uses listing-scoped custom IDs and disables all ended controls", () => {
    const active = controlMessage(listing);
    const activeJson = JSON.stringify(active.components);
    expect(activeJson).toContain("lsv1:change:listing-id");
    expect(activeJson).toContain("lsv1:extend:listing-id");
    expect(activeJson).toContain("lsv1:end:listing-id");
    const ended = controlMessage({ ...listing, active: false }, true);
    const endedJson = JSON.stringify(ended.components);
    expect(endedJson.match(/\"disabled\":true/g)).toHaveLength(3);
  });
});
