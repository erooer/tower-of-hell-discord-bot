import { ComponentType, TextInputStyle } from "discord.js";
import { describe, expect, it } from "vitest";
import {
  createPrivateServerUrlModal,
  PRIVATE_SERVER_URL_INPUT_ID,
  PRIVATE_SERVER_URL_LABEL
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
