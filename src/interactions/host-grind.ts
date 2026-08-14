import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type InteractionReplyOptions
} from "discord.js";

export const HOST_GRIND_SELECT_ID = "lshost:type";

export function hostGrindSelector(): InteractionReplyOptions {
  const selector = new StringSelectMenuBuilder()
    .setCustomId(HOST_GRIND_SELECT_ID)
    .setPlaceholder("Choose a grind type")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Carmine Hunting")
        .setEmoji("🔥")
        .setValue("carmine"),
      new StringSelectMenuOptionBuilder()
        .setLabel("XP Grinding")
        .setEmoji("⚡")
        .setValue("xp")
    );
  return {
    content: "What type of grind do you want to host?",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)]
  };
}
