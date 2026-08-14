import { EmbedBuilder, type Client, type MessageCreateOptions } from "discord.js";
import type { Config } from "../config.js";
import type { Listing } from "../live-servers/model.js";
import { SERVER_TYPE_PRESENTATION } from "../live-servers/model.js";

export type SessionLogEvent = {
  kind?: "session";
  title: string;
  action: string;
  listing: Listing;
  actor: { kind: "host" | "moderator"; userId: string } | { kind: "automatic"; label?: string };
  occurredAt: number;
};

export type ModerationStatusLogEvent = {
  kind: "host-status";
  title: string;
  action: string;
  targetUserId: string;
  moderatorId: string;
  result: string;
  dmDelivery?: "Delivered" | "Failed";
  occurredAt: number;
};

export type BlockedLinkLogEvent = {
  kind: "blocked-private-server-link";
  userId: string;
  occurredAt: number;
};

export type LogEvent = SessionLogEvent | ModerationStatusLogEvent | BlockedLinkLogEvent;

export interface SessionLogger {
  log(event: LogEvent): Promise<void>;
}

export const NO_SESSION_LOGGER: SessionLogger = { log: async () => undefined };

export function logEventFailureContext(event: LogEvent): { label: string; subjectId: string } {
  switch (event.kind) {
    case "host-status":
      return { label: event.title, subjectId: event.targetUserId };
    case "blocked-private-server-link":
      return { label: "Private Server Link Blocked", subjectId: event.userId };
    case "session":
    case undefined:
      return { label: event.title, subjectId: event.listing.id };
  }
}

export function sessionLogMessage(event: LogEvent): MessageCreateOptions {
  if (event.kind === "blocked-private-server-link") {
    return {
      allowedMentions: { users: [], roles: [], repliedUser: false },
      embeds: [new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle("Private Server Link Blocked")
        .addFields(
          { name: "User", value: `<@${event.userId}>`, inline: true },
          { name: "Developer ID", value: `\`${event.userId}\``, inline: true },
          { name: "Action", value: "Removed a private-server link from Session-commands" },
          { name: "Time", value: `<t:${Math.floor(event.occurredAt / 1_000)}:F>` }
        )]
    };
  }
  if (event.kind === "host-status") {
    return {
      allowedMentions: { users: [], roles: [], repliedUser: false },
      embeds: [new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(event.title)
        .addFields(
          { name: "Target", value: `<@${event.targetUserId}>`, inline: true },
          { name: "Developer ID", value: `\`${event.targetUserId}\``, inline: true },
          { name: "Moderator", value: `<@${event.moderatorId}>`, inline: true },
          { name: "Action", value: event.action },
          { name: "Result", value: event.result },
          ...(event.dmDelivery ? [{ name: "Notification DM", value: event.dmDelivery, inline: true }] : []),
          { name: "Time", value: `<t:${Math.floor(event.occurredAt / 1_000)}:F>` }
        )]
    };
  }
  const type = SERVER_TYPE_PRESENTATION[event.listing.type].activity;
  const endingEvent = event.title === "Session Ended";
  const hostName = endingEvent ? "Session by" : "Host";
  const actorName = endingEvent ? "Ended by" : event.actor.kind === "moderator" ? "Moderator" : "Actor";
  const actorValue = event.actor.kind === "automatic"
    ? event.actor.label ?? "Automatic expiration"
    : `<@${event.actor.userId}>`;
  return {
    allowedMentions: { users: [], roles: [], repliedUser: false },
    embeds: [new EmbedBuilder()
      .setColor(event.actor.kind === "moderator" ? 0xe67e22 : 0x3498db)
      .setTitle(event.title)
      .addFields(
        { name: hostName, value: `<@${event.listing.ownerId}>`, inline: true },
        { name: "Type", value: type, inline: true },
        { name: actorName, value: actorValue, inline: true },
        { name: endingEvent ? "Reason" : "Action", value: event.action },
        { name: "Time", value: `<t:${Math.floor(event.occurredAt / 1_000)}:F>`, inline: true },
        { name: "Listing", value: `\`${event.listing.id}\``, inline: true }
      )]
  };
}

export class DiscordSessionLogger implements SessionLogger {
  constructor(private readonly client: Client, private readonly config: Config) {}

  async log(event: LogEvent): Promise<void> {
    const channel = await this.client.channels.fetch(this.config.sessionLogsChannelId);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Configured session log channel ${this.config.sessionLogsChannelId} is not a guild text channel.`);
    }
    await channel.send(sessionLogMessage(event));
  }
}
