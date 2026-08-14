import type { Client, Guild, GuildTextBasedChannel } from "discord.js";
import type { Config } from "./config.js";

async function requireTextChannel(
  client: Client,
  id: string,
  variable: string,
  guildId: string
): Promise<GuildTextBasedChannel> {
  try {
    const channel = await client.channels.fetch(id);
    if (!channel?.isTextBased() || channel.isDMBased() || channel.guildId !== guildId) {
      throw new Error("Discord channel is not a guild text channel");
    }
    return channel;
  } catch (error) {
    throw new Error(`Invalid ${variable}: Discord channel not found, inaccessible, or not a guild text channel.`, { cause: error });
  }
}

async function requireRole(guild: Guild, id: string, variable: string): Promise<void> {
  try {
    const role = await guild.roles.fetch(id);
    if (!role) throw new Error("Discord role was not found in the configured guild");
  } catch (error) {
    throw new Error(`Invalid ${variable}: role not found in configured guild.`, { cause: error });
  }
}

export async function validateStartupConfiguration(client: Client, config: Config): Promise<void> {
  let guild: Guild;
  try {
    guild = await client.guilds.fetch(config.guildId);
  } catch (error) {
    throw new Error("Invalid DISCORD_GUILD_ID: Discord guild not found or inaccessible.", { cause: error });
  }

  await requireTextChannel(client, config.liveChannelId, "LIVE_SERVERS_CHANNEL_ID", config.guildId);
  await requireTextChannel(client, config.commandsChannelId, "SERVER_COMMANDS_CHANNEL_ID", config.guildId);
  await requireTextChannel(client, config.staffReportsChannelId, "STAFF_REPORTS_CHANNEL_ID", config.guildId);
  await requireTextChannel(client, config.sessionLogsChannelId, "SESSION_LOGS_CHANNEL_ID", config.guildId);
  await requireRole(guild, config.carmineRoleId, "CARMINE_ROLE_ID");
  await requireRole(guild, config.xpRoleId, "XP_ROLE_ID");
  await requireRole(guild, config.eventRoleId, "EVENT_ROLE_ID");
  await requireRole(guild, config.moderatorRoleId, "MODERATOR_ROLE_ID");
}
