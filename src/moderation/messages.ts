import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";
import { REPORT_THRESHOLD, reportReasonLabel, type CaseSnapshot, type ReporterSummary } from "./model.js";

function timestamp(ms: number, style: "f" | "R"): string {
  return `<t:${Math.floor(ms / 1_000)}:${style}>`;
}

function staffControls(snapshot: CaseSnapshot): ActionRowBuilder<ButtonBuilder> {
  const { listing, case: moderationCase } = snapshot;
  const resolved = moderationCase.status !== "open";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Join Server").setStyle(ButtonStyle.Link).setURL(listing.url).setDisabled(resolved),
    new ButtonBuilder().setCustomId(`lsmod:view:${listing.id}`).setLabel("View Reporters").setStyle(ButtonStyle.Secondary).setDisabled(resolved),
    new ButtonBuilder().setCustomId(`lsmod:ignore:${listing.id}`).setLabel("Ignore Reports").setStyle(ButtonStyle.Secondary).setDisabled(resolved),
    new ButtonBuilder().setCustomId(`lsmod:strike:${listing.id}`).setLabel("Strike / Remove").setStyle(ButtonStyle.Danger).setDisabled(resolved)
  );
}

function staffCaseEmbed(snapshot: CaseSnapshot, title: string, openColor: number): EmbedBuilder {
  const { listing, case: moderationCase } = snapshot;
  const resolved = moderationCase.status !== "open";
  const activity = listing.type === "carmine" ? "🔥 Carmine Hunting" : "⚡ XP Grinding Server";
  const status = resolved
    ? moderationCase.status === "struck" ? "Resolved — strike issued" : "Resolved — reports ignored"
    : "Open";
  const embed = new EmbedBuilder()
    .setColor(resolved ? 0x7f8c8d : openColor)
    .setTitle(title)
    .addFields(
      { name: "Activity", value: activity, inline: true },
      { name: "Host", value: `<@${listing.ownerId}>`, inline: true },
      { name: "Status", value: status, inline: true },
      { name: "Started", value: timestamp(listing.createdAt, "f"), inline: true },
      { name: "Expires", value: timestamp(listing.expiresAt, "R"), inline: true },
      { name: "Reports", value: `${snapshot.reportCount}/${REPORT_THRESHOLD}`, inline: true },
      { name: "Existing Valid Strikes", value: String(snapshot.hostStrikeCount), inline: true },
      {
        name: "Reasons",
        value: snapshot.reasonCounts
          .map(({ reason, count }) => `${reportReasonLabel(reason)} — ${count}`)
          .join("\n") || "No reason data available"
      }
    )
    .setFooter({ text: `Session ${listing.id}` });
  if (resolved && moderationCase.resolvedBy && moderationCase.resolvedAt) {
    embed.addFields({
      name: "Resolution",
      value: `By <@${moderationCase.resolvedBy}> at ${timestamp(moderationCase.resolvedAt, "f")}`
    });
  }
  return embed;
}

export function staffCaseMessage(snapshot: CaseSnapshot): MessageCreateOptions & MessageEditOptions {
  return {
    content: "",
    allowedMentions: { roles: [], users: [], repliedUser: false },
    embeds: [staffCaseEmbed(snapshot, "⚠️ Reported Session", 0xe67e22)],
    components: [staffControls(snapshot)]
  };
}

export function urgentCaseMessage(
  snapshot: CaseSnapshot,
  moderatorRoleId: string,
  pingModerators: boolean
): MessageCreateOptions & MessageEditOptions {
  return {
    content: `<@&${moderatorRoleId}>`,
    allowedMentions: { roles: pingModerators ? [moderatorRoleId] : [], users: [], repliedUser: false },
    embeds: [staffCaseEmbed(snapshot, "🚨 Urgent Report", 0xe74c3c)],
    components: [staffControls(snapshot)]
  };
}

export function reportersReply(sessionId: string, reporters: ReporterSummary[]): InteractionReplyOptions {
  const visible = reporters.slice(0, 25);
  const lines = visible.map((reporter) => {
    const reason = reportReasonLabel(reporter.reason);
    const reportLine = reporter.details ? `${reason}: ${reporter.details}` : reason;
    return `<@${reporter.userId}> (\`${reporter.userId}\`) — ${reportLine}\n` +
      `History: ${reporter.total} total | ${reporter.valid} valid | ${reporter.rejected} rejected`;
  });
  if (reporters.length > visible.length) lines.push(`…and ${reporters.length - visible.length} more reporter(s).`);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`lsmod:blacklist:${sessionId}`)
    .setPlaceholder("Select reporter to blacklist")
    .addOptions(visible.map((reporter) => new StringSelectMenuOptionBuilder()
      .setLabel(`Reporter ${reporter.userId}`.slice(0, 100))
      .setDescription(`${reporter.total} total | ${reporter.valid} valid | ${reporter.rejected} rejected`.slice(0, 100))
      .setValue(reporter.userId)));

  return {
    content: lines.join("\n").slice(0, 2_000),
    allowedMentions: { users: [], roles: [], repliedUser: false },
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)]
  };
}
