import {
  Events,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction
} from "discord.js";
import type { Config } from "../config.js";
import type { LiveServerService } from "../live-servers/service.js";
import { normalizePrivateServerUrl } from "../live-servers/url.js";
import {
  createLiveServerReportModal,
  createPrivateServerUrlModal,
  PRIVATE_SERVER_URL_INPUT_ID,
  REPORT_DETAILS_INPUT_ID,
  REPORT_REASON_INPUT_ID
} from "./modals.js";
import type { ModerationService } from "../moderation/service.js";
import type { StaffActor } from "../moderation/model.js";
import { hostGrindSelector, HOST_GRIND_SELECT_ID } from "./host-grind.js";
import { isServerType, SERVER_TYPE_PRESENTATION } from "../live-servers/model.js";


export function registerInteractionRouter(
  client: Client,
  service: LiveServerService,
  moderation: ModerationService,
  config: Config
): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) await handleCommand(interaction, service, moderation, config);
      else if (interaction.isButton() && interaction.customId.startsWith("hoststatus:")) {
        await handleHostStatusButton(interaction, moderation, config);
      }
      else if (interaction.isButton() && interaction.customId.startsWith("lsreport:")) await handleReportButton(interaction, moderation);
      else if (interaction.isModalSubmit() && interaction.customId.startsWith("lsreport:form:")) {
        await handleReportModal(interaction, moderation);
      }
      else if (interaction.isButton() && interaction.customId.startsWith("lsmod:")) await handleModerationButton(interaction, moderation);
      else if (interaction.isStringSelectMenu() && interaction.customId.startsWith("lsmod:blacklist:")) {
        await handleBlacklistSelect(interaction, moderation);
      }
      else if (interaction.isStringSelectMenu() && interaction.customId === HOST_GRIND_SELECT_ID) {
        await handleHostGrindSelect(interaction, service, config);
      }
      else if (interaction.isButton() && interaction.customId.startsWith("lsv1:")) await handleButton(interaction, service, moderation);
      else if (interaction.isModalSubmit() && interaction.customId.startsWith("lsv1:")) await handleModal(interaction, service, moderation, config);
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

async function handleReportButton(interaction: ButtonInteraction, moderation: ModerationService): Promise<void> {
  const [, action, sessionId] = interaction.customId.split(":");
  if (action !== "submit" || !sessionId) return;
  const eligibility = moderation.checkReportEligibility(sessionId, interaction.user.id, interaction.guildId);
  if (!eligibility.ok) {
    await interaction.reply({ content: eligibility.message, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.showModal(createLiveServerReportModal(sessionId));
}

async function handleReportModal(
  interaction: ModalSubmitInteraction,
  moderation: ModerationService
): Promise<void> {
  const [, action, sessionId] = interaction.customId.split(":");
  if (action !== "form" || !sessionId) return;
  let reason: string;
  let details: string;
  try {
    reason = interaction.fields.getStringSelectValues(REPORT_REASON_INPUT_ID)[0] ?? "";
    details = interaction.fields.getTextInputValue(REPORT_DETAILS_INPUT_ID);
  } catch {
    await interaction.reply({ content: "Select a valid report reason.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await moderation.report(sessionId, interaction.user.id, interaction.guildId, reason, details);
  await interaction.editReply(result.message);
}

async function handleModerationButton(interaction: ButtonInteraction, moderation: ModerationService): Promise<void> {
  const [, action, sessionId] = interaction.customId.split(":");
  if (!action || !sessionId) return;
  const actor = staffActor(interaction);
  if (action === "view") {
    const result = await moderation.viewReporters(sessionId, actor);
    if (!result.ok || !result.reportersPayload) {
      await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ ...result.reportersPayload, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = action === "ignore" || action === "strike"
    ? await moderation.resolve(sessionId, action, actor)
    : { ok: false, message: "Unknown moderation control." };
  await interaction.editReply(result.message);
}

async function handleBlacklistSelect(
  interaction: StringSelectMenuInteraction,
  moderation: ModerationService
): Promise<void> {
  const [, action, sessionId] = interaction.customId.split(":");
  const reporterId = interaction.values[0];
  if (action !== "blacklist" || !sessionId || !reporterId) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await moderation.blacklistReporter(sessionId, reporterId, staffActor(interaction));
  await interaction.editReply(result.message);
}

function staffActor(interaction: ButtonInteraction | StringSelectMenuInteraction | ChatInputCommandInteraction): StaffActor {
  const roles = interaction.member?.roles;
  const roleIds = Array.isArray(roles) ? roles : roles?.cache.map((role) => role.id) ?? [];
  return {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    roleIds
  };
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  service: LiveServerService,
  moderation: ModerationService,
  config: Config
): Promise<void> {
  if (interaction.commandName === "hoststatus") {
    await handleHostStatusCommand(interaction, moderation, config);
    return;
  }
  if (interaction.commandName !== "hostgrind") return;
  if (interaction.channelId !== config.commandsChannelId || interaction.guildId !== config.guildId) {
    await interaction.reply({ content: `This command only works in <#${config.commandsChannelId}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const eligibility = service.checkHostingEligibility(
    interaction.user.id,
    memberHasRole(interaction, config.moderatorRoleId)
  );
  if (!eligibility.ok) {
    await interaction.reply({ content: eligibility.message, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ ...hostGrindSelector(), flags: MessageFlags.Ephemeral });
}

async function handleHostStatusCommand(
  interaction: ChatInputCommandInteraction,
  moderation: ModerationService,
  config: Config
): Promise<void> {
  if (interaction.guildId !== config.guildId || !memberHasRole(interaction, config.moderatorRoleId)) {
    await interaction.reply({
      content: "You are not authorized to manage host moderation status.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const userId = interaction.options.getString("user_id", true).trim();
  if (!/^[0-9]{17,20}$/.test(userId)) {
    await interaction.reply({ content: "Enter a valid numeric Discord user ID.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await moderation.hostStatus(userId, staffActor(interaction));
  await interaction.editReply(result.hostStatusPayload ?? { content: result.message, embeds: [], components: [] });
}

async function handleHostStatusButton(
  interaction: ButtonInteraction,
  moderation: ModerationService,
  config: Config
): Promise<void> {
  const [, action, userId, stateToken] = interaction.customId.split(":");
  const actions = ["strike-add", "strike-remove", "host-blacklist", "host-unblacklist",
    "reporter-blacklist", "reporter-unblacklist", "cooldown-add", "cooldown-clear"];
  if (!action || !userId || !actions.includes(action)) return;
  if (interaction.guildId !== config.guildId || !memberHasRole(interaction, config.moderatorRoleId)) {
    await interaction.reply({
      content: "You are not authorized to manage host moderation status.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  await interaction.deferUpdate();
  const result = await moderation.updateHostStatus(
    userId,
    action as import("../moderation/host-status.js").HostStatusAction,
    stateToken ?? null,
    staffActor(interaction)
  );
  await interaction.editReply(result.hostStatusPayload ?? { content: result.message, embeds: [], components: [] });
}

async function handleHostGrindSelect(
  interaction: StringSelectMenuInteraction,
  service: LiveServerService,
  config: Config
): Promise<void> {
  if (interaction.channelId !== config.commandsChannelId || interaction.guildId !== config.guildId) {
    await interaction.reply({ content: `This action only works in <#${config.commandsChannelId}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const type = interaction.values[0];
  if (!type || !isServerType(type)) {
    await interaction.reply({ content: "Choose a valid grind type.", flags: MessageFlags.Ephemeral });
    return;
  }
  const eligibility = service.checkCreationEligibility(
    interaction.guildId,
    interaction.user.id,
    type,
    memberHasRole(interaction, config.moderatorRoleId)
  );
  if (!eligibility.ok) {
    await interaction.reply({ content: eligibility.message, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.showModal(createPrivateServerUrlModal(
    `lsv1:create:${type}`,
    SERVER_TYPE_PRESENTATION[type].modalTitle
  ));
}

function memberHasRole(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction | ButtonInteraction,
  roleId: string
): boolean {
  const roles = interaction.member?.roles;
  return Array.isArray(roles) ? roles.includes(roleId) : roles?.cache.has(roleId) ?? false;
}

async function handleButton(
  interaction: ButtonInteraction,
  service: LiveServerService,
  moderation: ModerationService
): Promise<void> {
  const [, action, id] = interaction.customId.split(":");
  if (!id || !action) return;
  const listing = service.get(id);
  if (!listing || !listing.active) {
    await interaction.reply({ content: "This listing is no longer active.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === "end") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await service.end(id, interaction.user.id);
    await interaction.editReply(result.message ?? "Done.");
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
    : { ok: false as const, message: "Unknown control." };
  if (result.ok && action === "extend") await moderation.refreshCase(id);
  await interaction.editReply(result.message ?? "Done.");
}

async function handleModal(
  interaction: ModalSubmitInteraction,
  service: LiveServerService,
  moderation: ModerationService,
  config: Config
): Promise<void> {
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
  if (action === "create" && isServerType(value)) {
    const result = await service.create(interaction.guildId, interaction.user.id, value, url);
    await interaction.editReply(result.message ?? "Done.");
    return;
  }
  if (action === "change") {
    const result = await service.changeUrl(value, interaction.user.id, url);
    if (result.ok) await moderation.refreshCase(value);
    await interaction.editReply(result.message ?? "Done.");
  }
}
