import { Events, type Client, type Message } from "discord.js";
import type { Config } from "../config.js";

export function registerCommandsOnlyFilter(client: Client, config: Config): void {
  client.on(Events.MessageCreate, (message) => {
    void handleCommandsOnlyMessage(message, config);
  });
}

export async function handleCommandsOnlyMessage(message: Message, config: Config): Promise<void> {
  if (message.guildId !== config.guildId || message.channelId !== config.commandsChannelId) return;
  if (message.author.bot || message.webhookId) return;

  let isModerator = message.member?.roles.cache.has(config.moderatorRoleId) ?? false;
  if (message.guild) {
    try {
      const member = await message.guild.members.fetch(message.author.id);
      isModerator = member.roles.cache.has(config.moderatorRoleId);
    } catch (error) {
      console.error("Failed to refresh member roles for Session-commands filtering", {
        userId: message.author.id,
        error
      });
    }
  }
  if (isModerator) return;

  try {
    await message.delete();
  } catch (error) {
    console.error("Failed to delete a normal message from Session-commands", {
      userId: message.author.id,
      messageId: message.id,
      error
    });
  }
}
