import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";
import type { Listing } from "./model.js";
import { SERVER_TYPE_PRESENTATION, typeLabel } from "./model.js";
import { REPORT_THRESHOLD } from "../moderation/model.js";

function discordTimestamp(ms: number, style: "t" | "R"): string {
  return `<t:${Math.floor(ms / 1_000)}:${style}>`;
}

export function liveMessage(listing: Listing, roleId: string, reportCount = 0): MessageCreateOptions & MessageEditOptions {
  const presentation = SERVER_TYPE_PRESENTATION[listing.type];
  const joinRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Join Server")
      .setStyle(ButtonStyle.Link)
      .setURL(listing.url),
    new ButtonBuilder()
      .setCustomId(`lsreport:submit:${listing.id}`)
      .setEmoji("⚠️")
      .setStyle(ButtonStyle.Danger)
  );
  return {
    content: `<@&${roleId}>`,
    allowedMentions: { roles: [roleId], users: [], repliedUser: false },
    embeds: [
      new EmbedBuilder()
        .setColor(presentation.color)
        .setTitle(presentation.announcementTitle)
        .setDescription(presentation.announcementDescription ?? null)
        .addFields(
          { name: "Host", value: `<@${listing.ownerId}>`, inline: true },
          ...(listing.type === "event" ? [{ name: "Activity", value: "Event", inline: true }] : []),
          { name: "Started", value: discordTimestamp(listing.createdAt, "t"), inline: true },
          { name: "Expires", value: discordTimestamp(listing.expiresAt, "R"), inline: true },
          { name: "Reports", value: `⚠️ ${reportCount}/${REPORT_THRESHOLD}`, inline: true }
        )
    ],
    components: [joinRow]
  };
}

export function controlMessage(listing: Listing, disabled = !listing.active): MessageCreateOptions & MessageEditOptions {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`lsv1:change:${listing.id}`)
      .setLabel("Change Link")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`lsv1:extend:${listing.id}`)
      .setLabel("Extend +1h")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`lsv1:end:${listing.id}`)
      .setLabel("End Session")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
  const status = listing.active ? "🟢 Live" : "⚫ Ended";
  return {
    content: `<@${listing.ownerId}>`,
    allowedMentions: { users: [listing.ownerId], roles: [], repliedUser: false },
    embeds: [
      new EmbedBuilder()
        .setColor(listing.active ? 0x2ecc71 : 0x7f8c8d)
        .setTitle(`${typeLabel(listing.type)} Server`)
        .setDescription(
          `**Status:** ${status}\n` +
          `**Expires:** ${discordTimestamp(listing.expiresAt, "R")}\n` +
          `**Extension:** 🔒 Available during the final 30 minutes`
        )
        .setFooter({ text: `Listing ${listing.id}` })
    ],
    components: [row]
  };
}
