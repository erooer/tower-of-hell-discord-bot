import { ComponentType, TextInputStyle } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  createLiveServerReportModal,
  createPrivateServerUrlModal,
  PRIVATE_SERVER_URL_INPUT_ID,
  PRIVATE_SERVER_URL_LABEL,
  REPORT_DETAILS_INPUT_ID,
  REPORT_REASON_INPUT_ID
} from "../src/interactions/modals.js";

const modalCases = [
  { name: "/carmine", customId: "lsv1:create:carmine", title: "Start a Carmine Hunt" },
  { name: "/xp", customId: "lsv1:create:xp", title: "Start XP Grinding" },
  { name: "Change Link", customId: "lsv1:change:listing-id", title: "Change private-server link" }
];

describe("Live Server URL modals", () => {
  it.each(modalCases)("builds a labeled current-API payload for $name", ({ customId, title }) => {
    const payload = createPrivateServerUrlModal(customId, title).toJSON();

    expect(payload.custom_id).toBe(customId);
    expect(payload.title).toBe(title);
    expect(payload.components).toHaveLength(1);

    const label = payload.components[0];
    if (!label || label.type !== ComponentType.Label) {
      throw new Error("Expected the modal field to be a Discord label component.");
    }
    expect(label.type).toBe(ComponentType.Label);
    expect(label.label).toBe(PRIVATE_SERVER_URL_LABEL);
    expect(label.label.trim().length).toBeGreaterThan(0);

    expect(label.component).toMatchObject({
      type: ComponentType.TextInput,
      custom_id: PRIVATE_SERVER_URL_INPUT_ID,
      style: TextInputStyle.Short,
      required: true,
      max_length: 500
    });
  });
});

describe("Live Server report modal", () => {
  it("builds a required single-select reason and optional bounded details field", () => {
    const payload = createLiveServerReportModal("session-id").toJSON();
    expect(payload.custom_id).toBe("lsreport:form:session-id");
    expect(payload.title).toBe("Report Live Server");
    expect(payload.components).toHaveLength(2);

    const reasonLabel = payload.components[0];
    const detailsLabel = payload.components[1];
    if (!reasonLabel || reasonLabel.type !== ComponentType.Label ||
        !detailsLabel || detailsLabel.type !== ComponentType.Label) {
      throw new Error("Expected labeled report modal fields.");
    }
    expect(reasonLabel.label).toBe("Reason for report");
    expect(reasonLabel.component).toMatchObject({
      type: ComponentType.StringSelect,
      custom_id: REPORT_REASON_INPUT_ID,
      min_values: 1,
      max_values: 1,
      options: [
        { label: "Host is not in the server", value: "host_not_in_server" },
        { label: "Server doesn't exist", value: "server_missing" },
        { label: "Incorrect category of grind", value: "wrong_category" },
        { label: "Other", value: "other" }
      ]
    });
    expect(detailsLabel.label).toBe("Additional details (optional)");
    expect(detailsLabel.component).toMatchObject({
      type: ComponentType.TextInput,
      custom_id: REPORT_DETAILS_INPUT_ID,
      required: false,
      max_length: 300
    });
  });
});
