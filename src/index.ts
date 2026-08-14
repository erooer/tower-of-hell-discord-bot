import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { loadConfig } from "./config.js";
import { registerInteractionRouter } from "./interactions/router.js";
import { ExpirationScheduler } from "./live-servers/scheduler.js";
import { LiveServerService } from "./live-servers/service.js";
import { openDatabase } from "./storage/database.js";
import { ListingRepository } from "./storage/listing-repository.js";
import { ModerationRepository } from "./storage/moderation-repository.js";
import { ModerationService } from "./moderation/service.js";
import { HostCooldownRepository } from "./storage/host-cooldown-repository.js";
import { DiscordSessionLogger } from "./logging/session-logger.js";
import { validateStartupConfiguration } from "./startup-validation.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const repository = new ListingRepository(database);
const moderationRepository = new ModerationRepository(database);
const hostCooldownRepository = new HostCooldownRepository(database);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message]
});
const sessionLogger = new DiscordSessionLogger(client, config);
const service = new LiveServerService(
  client,
  repository,
  config,
  Date.now,
  undefined,
  moderationRepository,
  hostCooldownRepository,
  sessionLogger
);
const moderation = new ModerationService(
  client,
  repository,
  moderationRepository,
  service,
  config,
  Date.now,
  hostCooldownRepository,
  sessionLogger
);
const scheduler = new ExpirationScheduler(service, config.expirationPollMs);

registerInteractionRouter(client, service, moderation, config);

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  try {
    await validateStartupConfiguration(readyClient, config);
    await service.reconcileActive();
    await moderation.reconcileCases();
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
