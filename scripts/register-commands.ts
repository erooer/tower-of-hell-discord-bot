import { REST, Routes } from "discord.js";
import { liveServerCommands } from "../src/commands/live-server-commands.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.token);

await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: liveServerCommands });
console.log(`Registered /carmine and /xp in guild ${config.guildId}.`);
