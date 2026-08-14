import { Events, type Client, type Message } from "discord.js";
import type { Config } from "../config.js";
import { findPrivateServerUrl } from "../live-servers/url.js";
import type { SessionLogger } from "../logging/session-logger.js";

export const PRIVATE_SERVER_LINK_WARNING =
  "Use /hostgrind to host a server. If you are on cooldown, contact a Moderator to remove it.";

export function registerPrivateServerLinkFilter(
  client: Client,
  config: Config,
  sessionLogger: SessionLogger,
  now: () => number = Date.now
): void {
  client.on(Events.MessageCreate, (message) => {
    void handlePrivateServerLinkMessage(message, config, sessionLogger, now);
  });
}

export async function handlePrivateServerLinkMessage(
  message: Message,
  config: Config,
  sessionLogger: SessionLogger,
  now: () => number = Date.now
): Promise<void> {
  if (message.guildId !== config.guildId || message.channelId !== config.commandsChannelId) return;
  if (message.author.bot || message.webhookId) return;
  if (!findPrivateServerUrl(message.content)) return;

  let isModerator = message.member?.roles.cache.has(config.moderatorRoleId) ?? false;
  if (message.guild) {
    try {
      const member = await message.guild.members.fetch(message.author.id);
      isModerator = member.roles.cache.has(config.moderatorRoleId);
    } catch (error) {
      console.error("Failed to refresh member roles for private-server link filtering", {
        userId: message.author.id,
        error
      });
    }
  }
  if (isModerator) return;

  try {
    await message.delete();
  } catch (error) {
    console.error("Failed to delete a private-server link from Session-commands", {
      userId: message.author.id,
      messageId: message.id,
      error
    });
  }

  try {
    if (!message.channel.isSendable()) throw new Error("Configured Session-commands channel is not sendable.");
    await message.channel.send({
      content: PRIVATE_SERVER_LINK_WARNING,
      allowedMentions: { users: [], roles: [], repliedUser: false }
    });
  } catch (error) {
    console.error("Failed to send the private-server link warning", {
      userId: message.author.id,
      messageId: message.id,
      error
    });
  }

  try {
    await sessionLogger.log({
      kind: "blocked-private-server-link",
      userId: message.author.id,
      occurredAt: now()
    });
  } catch (error) {
    console.error("Failed to log a blocked private-server link", {
      userId: message.author.id,
      messageId: message.id,
      error
    });
  }
}
