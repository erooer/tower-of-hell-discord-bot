import { SlashCommandBuilder } from "discord.js";

export const liveServerCommands = [
  new SlashCommandBuilder()
    .setName("hostgrind")
    .setDescription("Host a Tower of Hell Carmine or XP private-server listing")
].map((command) => command.toJSON());
