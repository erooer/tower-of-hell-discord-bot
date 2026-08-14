import { SlashCommandBuilder } from "discord.js";

export const liveServerCommands = [
  new SlashCommandBuilder()
    .setName("hostgrind")
    .setDescription("Host a Tower of Hell Carmine or XP private-server listing"),
  new SlashCommandBuilder()
    .setName("hoststatus")
    .setDescription("Inspect and manage a user's hosting moderation status")
    .addStringOption((option) => option
      .setName("user_id")
      .setDescription("Discord user ID / developer ID")
      .setRequired(true))
].map((command) => command.toJSON());
