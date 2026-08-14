import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions
} from "discord.js";
import type { HostCooldown } from "../storage/host-cooldown-repository.js";
import type { HostModerationStatus } from "../storage/moderation-repository.js";

export type HostStatusAction = "strike" | "host-unblacklist" | "reporter-unblacklist" | "cooldown";

export type HostStatusSnapshot = {
  userId: string;
  moderation: HostModerationStatus;
  cooldown: HostCooldown | null;
  now: number;
};

function date(value: number | null): string {
  return value ? `<t:${Math.floor(value / 1_000)}:F>` : "None";
}

export function hostStatusMessage(
  snapshot: HostStatusSnapshot,
  notice?: string
): InteractionReplyOptions & InteractionEditReplyOptions {
  const { moderation, cooldown, userId, now } = snapshot;
  const cooldownActive = Boolean(cooldown && cooldown.nextEligibleAt > now);
  const cooldownValue = cooldownActive && cooldown
    ? `Active — ends <t:${Math.floor(cooldown.nextEligibleAt / 1_000)}:R> (<t:${Math.floor(cooldown.nextEligibleAt / 1_000)}:F>)`
    : "Not active";
  const embed = new EmbedBuilder()
    .setColor(moderation.hostBlacklisted ? 0xe74c3c : 0x3498db)
    .setTitle("Host Moderation Status")
    .addFields(
      { name: "User", value: `<@${userId}>\n\`${userId}\`` },
      { name: "Host Strikes", value: `${moderation.strikeCount} / 3`, inline: true },
      { name: "Host Blacklisted", value: moderation.hostBlacklisted ? "Yes" : "No", inline: true },
      { name: "Reporter Blacklisted", value: moderation.reporterBlacklisted ? "Yes" : "No", inline: true },
      { name: "Hosting Cooldown", value: cooldownValue },
      {
        name: "Report History",
        value: `${moderation.reportHistory.total} total | ${moderation.reportHistory.valid} valid | ${moderation.reportHistory.rejected} rejected`
      },
      { name: "Most Recent Host Strike", value: date(moderation.latestStrikeAt), inline: true },
      { name: "Host Blacklisted At", value: date(moderation.hostBlacklistedAt), inline: true },
      { name: "Reporter Blacklisted At", value: date(moderation.reporterBlacklistedAt), inline: true }
    );

  const buttons: ButtonBuilder[] = [];
  if (moderation.latestActiveStrikeId) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`hoststatus:strike:${userId}:${moderation.latestActiveStrikeId}`)
      .setLabel("Remove Strike")
      .setStyle(ButtonStyle.Danger));
  }
  if (moderation.hostBlacklisted) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`hoststatus:host-unblacklist:${userId}`)
      .setLabel("Remove Host Blacklist")
      .setStyle(ButtonStyle.Secondary));
  }
  if (moderation.reporterBlacklisted) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`hoststatus:reporter-unblacklist:${userId}`)
      .setLabel("Remove Reporter Blacklist")
      .setStyle(ButtonStyle.Secondary));
  }
  if (cooldownActive) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`hoststatus:cooldown:${userId}`)
      .setLabel("Clear Cooldown")
      .setStyle(ButtonStyle.Secondary));
  }

  return {
    content: notice ?? "",
    allowedMentions: { users: [], roles: [], repliedUser: false },
    embeds: [embed],
    components: buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : []
  };
}
