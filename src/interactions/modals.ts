import {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { REPORT_REASONS } from "../moderation/model.js";

export const PRIVATE_SERVER_URL_INPUT_ID = "private-server-url";
export const PRIVATE_SERVER_URL_LABEL = "Roblox Private Server Link";
export const REPORT_REASON_INPUT_ID = "report-reason";
export const REPORT_DETAILS_INPUT_ID = "report-details";

/**
 * Builds the URL modal shared by all live-session types and Change Link.
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

export function createLiveServerReportModal(sessionId: string): ModalBuilder {
  const reasonSelect = new StringSelectMenuBuilder()
    .setCustomId(REPORT_REASON_INPUT_ID)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(Object.entries(REPORT_REASONS).map(([value, label]) =>
      new StringSelectMenuOptionBuilder().setLabel(label).setValue(value)
    ));
  const detailsInput = new TextInputBuilder()
    .setCustomId(REPORT_DETAILS_INPUT_ID)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Required when selecting Other")
    .setRequired(false)
    .setMaxLength(300);

  return new ModalBuilder()
    .setCustomId(`lsreport:form:${sessionId}`)
    .setTitle("Report Live Server")
    .addLabelComponents(
      new LabelBuilder().setLabel("Reason for report").setStringSelectMenuComponent(reasonSelect),
      new LabelBuilder().setLabel("Additional details (optional)").setTextInputComponent(detailsInput)
    );
}
