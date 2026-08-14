import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type InteractionReplyOptions,
  type InteractionUpdateOptions
} from "discord.js";
import type { ServerType } from "../live-servers/model.js";

export const HOST_GRIND_SELECT_ID = "lshost:type";
export const HOST_SOURCE_PREFIX = "lshost:source";

export function hostGrindSelector(): InteractionReplyOptions {
  const selector = new StringSelectMenuBuilder()
    .setCustomId(HOST_GRIND_SELECT_ID)
    .setPlaceholder("Choose a session type")
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
        .setValue("xp"),
      new StringSelectMenuOptionBuilder()
        .setLabel("Event")
        .setEmoji("🎉")
        .setValue("event")
    );
  return {
    content: "What type of session do you want to host?",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selector)]
  };
}

export function hostSourceSelector(type: ServerType): InteractionUpdateOptions {
  return {
    content: "Who is hosting the private server?",
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${HOST_SOURCE_PREFIX}:self:${type}`)
        .setLabel("Self Hosted")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${HOST_SOURCE_PREFIX}:other:${type}`)
        .setLabel("Other")
        .setStyle(ButtonStyle.Secondary)
    )]
  };
}
