import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { loadConfig } from "./config.js";
import { registerInteractionRouter } from "./interactions/router.js";
import { ExpirationScheduler } from "./live-servers/scheduler.js";
import { LiveServerService } from "./live-servers/service.js";
import { openDatabase } from "./storage/database.js";
import { ListingRepository } from "./storage/listing-repository.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const repository = new ListingRepository(database);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message]
});
const service = new LiveServerService(client, repository, config);
const scheduler = new ExpirationScheduler(service, config.expirationPollMs);

registerInteractionRouter(client, service, config);

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  try {
    const guild = await readyClient.guilds.fetch(config.guildId);
    const [liveChannel, commandsChannel, carmineRole, xpRole] = await Promise.all([
      readyClient.channels.fetch(config.liveChannelId),
      readyClient.channels.fetch(config.commandsChannelId),
      guild.roles.fetch(config.carmineRoleId),
      guild.roles.fetch(config.xpRoleId)
    ]);
    if (!liveChannel?.isTextBased() || liveChannel.isDMBased()) throw new Error("LIVE_SERVERS_CHANNEL_ID is not a guild text channel.");
    if (!commandsChannel?.isTextBased() || commandsChannel.isDMBased()) throw new Error("SERVER_COMMANDS_CHANNEL_ID is not a guild text channel.");
    if (!carmineRole) throw new Error("CARMINE_ROLE_ID was not found in the configured guild.");
    if (!xpRole) throw new Error("XP_ROLE_ID was not found in the configured guild.");
    await service.reconcileActive();
    scheduler.start();
    console.log(`Live Server V1 ready with ${repository.listActive().length} active listing(s).`);
  } catch (error) {
    console.error("Startup validation/reconciliation failed. The bot will not accept interactions.", error);
    await client.destroy();
    process.exitCode = 1;
  }
});

client.on(Events.MessageDelete, (message) => {
  if (message.channelId === config.liveChannelId) void service.handleDeletedMessage(message.id);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  scheduler.stop();
  client.destroy();
  database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

client.login(config.token).catch((error) => {
  console.error("Discord login failed", error);
  database.close();
  process.exitCode = 1;
});
