import { describe, expect, it } from "vitest";
import type { APIEmbed } from "discord.js";
import { controlMessage, liveMessage } from "../src/live-servers/messages.js";
import type { Listing } from "../src/live-servers/model.js";

const listing: Listing = {
  id: "listing-id", guildId: "guild", ownerId: "12345678901234567", type: "carmine",
  url: "https://www.roblox.com/share?code=AbCdEfGh1234&type=Server",
  liveChannelId: "live", liveMessageId: "message", controlChannelId: "commands", controlMessageId: "panel",
  createdAt: 1_800_000_000_000, expiresAt: 1_800_007_200_000, active: true, cleanupPending: false,
  endedAt: null, endedReason: null, updatedAt: 1_800_000_000_000
};

function firstEmbed(message: ReturnType<typeof liveMessage>): APIEmbed {
  return JSON.parse(JSON.stringify(message.embeds?.[0])) as APIEmbed;
}

describe("Discord message builders", () => {
  it.each([
    { type: "carmine" as const, title: "🔥 Carmine Hunting" },
    { type: "xp" as const, title: "⚡ XP Grinding Server" }
  ])("builds the canonical $type announcement layout", ({ type, title }) => {
    const typedListing = { ...listing, type };
    const message = liveMessage(typedListing, "98765432109876543");
    expect(message.content).toBe("<@&98765432109876543>");
    expect(message.allowedMentions).toEqual({ roles: ["98765432109876543"], users: [], repliedUser: false });
    expect(message.embeds).toHaveLength(1);
    const embed = firstEmbed(message);
    const embedJson = JSON.stringify(embed);
    expect(embed).toMatchObject({
      title,
      fields: [
        { name: "Host", value: "<@12345678901234567>", inline: true },
        { name: "Started", value: "<t:1800000000:t>", inline: true },
        { name: "Expires", value: "<t:1800007200:R>", inline: false }
      ]
    });
    expect(embed.description).toBeUndefined();
    expect(embedJson).not.toContain(typedListing.url);
    expect(embedJson).not.toContain("Tower of Hell");

    const componentsJson = JSON.stringify(message.components);
    expect(componentsJson).toContain('"label":"Join Server"');
    expect(componentsJson).toContain('"style":5');
    expect(componentsJson).toContain(`"url":"${typedListing.url}"`);
  });

  it("changes only the button URL when Change Link supplies an updated listing", () => {
    const replacementUrl = "https://www.roblox.com/share?code=Replacement123&type=Server";
    const original = liveMessage(listing, "98765432109876543");
    const changed = liveMessage({ ...listing, url: replacementUrl }, "98765432109876543");

    expect(JSON.stringify(original.embeds)).toBe(JSON.stringify(changed.embeds));
    expect(JSON.stringify(original.components)).toContain(listing.url);
    expect(JSON.stringify(changed.components)).toContain(replacementUrl);
    expect(JSON.stringify(changed.components)).not.toContain(listing.url);
  });

  it("changes only the expiration display when a listing is extended", () => {
    const original = liveMessage(listing, "98765432109876543");
    const extended = liveMessage({ ...listing, expiresAt: listing.expiresAt + 3_600_000 }, "98765432109876543");
    const originalEmbed = firstEmbed(original);
    const extendedEmbed = firstEmbed(extended);
    expect(extendedEmbed).toMatchObject({
      title: "🔥 Carmine Hunting",
      fields: [
        { name: "Host", value: "<@12345678901234567>" },
        { name: "Started", value: "<t:1800000000:t>" },
        { name: "Expires", value: "<t:1800010800:R>" }
      ]
    });
    expect(extendedEmbed?.fields?.[0]).toEqual(originalEmbed?.fields?.[0]);
    expect(extendedEmbed?.fields?.[1]).toEqual(originalEmbed?.fields?.[1]);
    expect(JSON.stringify(extended.components)).toContain(listing.url);
    expect(JSON.stringify(extended.components)).toContain('"label":"Join Server"');
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
