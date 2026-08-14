import { EmbedBuilder, type Client, type MessageCreateOptions } from "discord.js";
import type { Config } from "../config.js";
import type { Listing } from "../live-servers/model.js";

export type SessionLogEvent = {
  title: string;
  action: string;
  listing: Listing;
  actor: { kind: "host" | "moderator"; userId: string } | { kind: "automatic"; label?: string };
  occurredAt: number;
};

export interface SessionLogger {
  log(event: SessionLogEvent): Promise<void>;
}

export const NO_SESSION_LOGGER: SessionLogger = { log: async () => undefined };

export function sessionLogMessage(event: SessionLogEvent): MessageCreateOptions {
  const type = event.listing.type === "carmine" ? "🔥 Carmine Hunting" : "⚡ XP Grinding";
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

  async log(event: SessionLogEvent): Promise<void> {
    const channel = await this.client.channels.fetch(this.config.sessionLogsChannelId);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Configured session log channel ${this.config.sessionLogsChannelId} is not a guild text channel.`);
    }
    await channel.send(sessionLogMessage(event));
  }
}
