import { LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

export const PRIVATE_SERVER_URL_INPUT_ID = "private-server-url";
export const PRIVATE_SERVER_URL_LABEL = "Roblox Private Server Link";

/**
 * Builds the URL modal shared by Carmine creation, XP creation, and Change Link.
 * Current Discord modal payloads require text inputs to be contained by a label
 * component with visible label text.
 */
export function createPrivateServerUrlModal(customId: string, title: string): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(PRIVATE_SERVER_URL_INPUT_ID)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("https://www.roblox.com/share?code=...")
    .setRequired(true)
    .setMaxLength(500);

  const field = new LabelBuilder()
    .setLabel(PRIVATE_SERVER_URL_LABEL)
    .setTextInputComponent(input);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addLabelComponents(field);
}
