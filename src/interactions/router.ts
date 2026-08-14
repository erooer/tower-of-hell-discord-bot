import {
  Events,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction
} from "discord.js";
import type { Config } from "../config.js";
import type { ServerType } from "../live-servers/model.js";
import type { LiveServerService } from "../live-servers/service.js";
import { normalizePrivateServerUrl } from "../live-servers/url.js";
import { createPrivateServerUrlModal, PRIVATE_SERVER_URL_INPUT_ID } from "./modals.js";


export function registerInteractionRouter(client: Client, service: LiveServerService, config: Config): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) await handleCommand(interaction, service, config);
      else if (interaction.isButton() && interaction.customId.startsWith("lsv1:")) await handleButton(interaction, service);
      else if (interaction.isModalSubmit() && interaction.customId.startsWith("lsv1:")) await handleModal(interaction, service, config);
    } catch (error) {
      console.error("Unhandled interaction error", error);
      const response = { content: "Something went wrong while handling that request. Please try again.", flags: MessageFlags.Ephemeral } as const;
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => undefined);
        else await interaction.reply(response).catch(() => undefined);
      }
    }
  });
}

async function handleCommand(interaction: ChatInputCommandInteraction, service: LiveServerService, config: Config): Promise<void> {
  if (interaction.commandName !== "carmine" && interaction.commandName !== "xp") return;
  if (interaction.channelId !== config.commandsChannelId || interaction.guildId !== config.guildId) {
    await interaction.reply({ content: `This command only works in <#${config.commandsChannelId}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const type: ServerType = interaction.commandName;
  if (service.findActive(interaction.guildId, interaction.user.id, type)) {
    await interaction.reply({ content: "You already have an active listing of this type. Use its existing control panel.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.showModal(createPrivateServerUrlModal(
    `lsv1:create:${type}`,
    type === "carmine" ? "Start a Carmine Hunt" : "Start XP Grinding"
  ));
}

async function handleButton(interaction: ButtonInteraction, service: LiveServerService): Promise<void> {
  const [, action, id] = interaction.customId.split(":");
  if (!id || !action) return;
  const listing = service.get(id);
  if (!listing || !listing.active) {
    await interaction.reply({ content: "This listing is no longer active.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.user.id !== listing.ownerId) {
    await interaction.reply({ content: "Only the person who created this listing can use its controls.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === "change") {
    await interaction.showModal(createPrivateServerUrlModal(`lsv1:change:${id}`, "Change private-server link"));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = action === "extend"
    ? await service.extend(id, interaction.user.id)
    : action === "end"
      ? await service.end(id, interaction.user.id)
      : { ok: false as const, message: "Unknown control." };
  await interaction.editReply(result.message ?? "Done.");
}

async function handleModal(interaction: ModalSubmitInteraction, service: LiveServerService, config: Config): Promise<void> {
  const [, action, value] = interaction.customId.split(":");
  if (!action || !value) return;
  if (interaction.channelId !== config.commandsChannelId || interaction.guildId !== config.guildId) {
    await interaction.reply({ content: `This action only works in <#${config.commandsChannelId}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const url = normalizePrivateServerUrl(interaction.fields.getTextInputValue(PRIVATE_SERVER_URL_INPUT_ID));
  if (!url) {
    await interaction.reply({
      content: "That is not a valid Roblox private-server link. Use an HTTPS roblox.com share link or game link containing its private-server code.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (action === "create" && (value === "carmine" || value === "xp")) {
    const result = await service.create(interaction.guildId, interaction.user.id, value, url);
    await interaction.editReply(result.message ?? "Done.");
    return;
  }
  if (action === "change") {
    const result = await service.changeUrl(value, interaction.user.id, url);
    await interaction.editReply(result.message ?? "Done.");
  }
}
