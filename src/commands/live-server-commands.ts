import { SlashCommandBuilder } from "discord.js";

export const liveServerCommands = [
  new SlashCommandBuilder()
    .setName("carmine")
    .setDescription("Create a two-hour Carmine Hunt private-server listing"),
  new SlashCommandBuilder()
    .setName("xp")
    .setDescription("Create a two-hour XP Grinding private-server listing")
].map((command) => command.toJSON());
