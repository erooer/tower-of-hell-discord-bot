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
        { name: "Expires", value: "<t:1800007200:R>", inline: true },
        { name: "Reports", value: "⚠️ 0/7", inline: true }
      ]
    });
    expect(embed.description).toBeUndefined();
    expect(embedJson).not.toContain(typedListing.url);
    expect(embedJson).not.toContain("Tower of Hell");

    const componentsJson = JSON.stringify(message.components);
    expect(componentsJson).toContain('"label":"Join Server"');
    expect(componentsJson).toContain('"style":5');
    expect(componentsJson).toContain(`"url":"${typedListing.url}"`);
    expect(componentsJson).toContain(`"custom_id":"lsreport:submit:${typedListing.id}"`);
    expect(componentsJson).toContain('"emoji":{"name":"⚠️"');
    expect(componentsJson).not.toContain('"label":"Report"');
  });

  it("builds the Event announcement with its dedicated text, activity, role ping, and controls", () => {
    const eventListing = { ...listing, type: "event" as const };
    const message = liveMessage(eventListing, "event-role");
    const embed = firstEmbed(message);
    expect(message.content).toBe("<@&event-role>");
    expect(message.allowedMentions).toEqual({ roles: ["event-role"], users: [], repliedUser: false });
    expect(embed).toMatchObject({
      title: "Event Session",
      description: "An event is currently being hosted!",
      fields: [
        { name: "Host", value: "<@12345678901234567>", inline: true },
        { name: "Activity", value: "Event", inline: true },
        { name: "Started", value: "<t:1800000000:t>", inline: true },
        { name: "Expires", value: "<t:1800007200:R>", inline: true },
        { name: "Reports", value: "⚠️ 0/7", inline: true }
      ]
    });
    const json = JSON.stringify(message);
    expect(json).toContain('"label":"Join Server"');
    expect(json).toContain(eventListing.url);
    expect(json).not.toContain("carmine-role");
    expect(json).not.toContain("xp-role");
  });

  it("preserves Event presentation while changing its URL or expiration", () => {
    const eventListing = { ...listing, type: "event" as const };
    const changed = liveMessage({ ...eventListing, url: "https://www.roblox.com/share?code=EventNew&type=Server" }, "event-role");
    const extended = liveMessage({ ...eventListing, expiresAt: eventListing.expiresAt + 3_600_000 }, "event-role");
    expect(JSON.stringify(changed)).toContain("EventNew");
    expect(firstEmbed(changed)).toMatchObject({ title: "Event Session", description: "An event is currently being hosted!" });
    expect(firstEmbed(extended).fields).toContainEqual({ name: "Expires", value: "<t:1800010800:R>", inline: true });
    expect(JSON.stringify(extended.components)).toContain(eventListing.url);
  });

  it.each([0, 1, 6, 7, 8, 10])("displays the real unique report count %i against the threshold", (count) => {
    const embed = firstEmbed(liveMessage(listing, "98765432109876543", count));
    expect(embed.fields?.[3]).toEqual({ name: "Reports", value: `⚠️ ${count}/7`, inline: true });
  });

  it("updates the direct Join Server URL when Change Link updates persisted state", () => {
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
        { name: "Expires", value: "<t:1800010800:R>" },
        { name: "Reports", value: "⚠️ 0/7" }
      ]
    });
    expect(extendedEmbed?.fields?.[0]).toEqual(originalEmbed?.fields?.[0]);
    expect(extendedEmbed?.fields?.[1]).toEqual(originalEmbed?.fields?.[1]);
    expect(JSON.stringify(extended.components)).toContain('"style":5');
    expect(JSON.stringify(extended.components)).toContain(listing.url);
    expect(JSON.stringify(extended.components)).toContain('"label":"Join Server"');
  });

  it("uses listing-scoped custom IDs and disables all ended controls", () => {
    const active = controlMessage(listing);
    const activeJson = JSON.stringify(active.components);
    expect(activeJson).toContain("lsv1:change:listing-id");
    expect(activeJson).toContain("lsv1:extend:listing-id");
    expect(activeJson).toContain("lsv1:end:listing-id");
    expect(activeJson).toContain('"label":"End Session"');
    expect(activeJson).not.toContain('"label":"End Server"');
    expect(JSON.stringify(active.embeds)).toContain("Available during the final 30 minutes");
    expect(JSON.stringify(active.embeds)).not.toContain("final 10 minutes");
    const ended = controlMessage({ ...listing, active: false }, true);
    const endedJson = JSON.stringify(ended.components);
    expect(endedJson.match(/\"disabled\":true/g)).toHaveLength(3);
  });
});
