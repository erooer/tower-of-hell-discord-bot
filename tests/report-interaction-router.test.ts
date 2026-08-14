import { Events, MessageFlags, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { registerInteractionRouter } from "../src/interactions/router.js";
import type { LiveServerService } from "../src/live-servers/service.js";
import type { ModerationService } from "../src/moderation/service.js";

const config = {
  guildId: "guild", commandsChannelId: "commands"
} as Config;

function installRouter(moderation: Partial<ModerationService>) {
  let handler!: (interaction: any) => Promise<void>;
  const client = {
    on: vi.fn((event: string, callback: typeof handler) => {
      if (event === Events.InteractionCreate) handler = callback;
      return client;
    })
  } as unknown as Client;
  registerInteractionRouter(client, {} as LiveServerService, moderation as ModerationService, config);
  return handler;
}

function baseInteraction() {
  return {
    customId: "lsreport:submit:session-id",
    user: { id: "reporter" },
    guildId: "guild",
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    showModal: vi.fn(async (_modal: unknown) => undefined),
    reply: vi.fn(async (_payload: unknown) => undefined),
    followUp: vi.fn(async (_payload: unknown) => undefined),
    deferred: false,
    replied: false
  };
}

describe("report interaction routing", () => {
  it("clicking Report opens the modal and does not submit a report", async () => {
    const checkReportEligibility = vi.fn(() => ({ ok: true, message: "Eligible to report." }));
    const report = vi.fn();
    const handler = installRouter({ checkReportEligibility, report });
    const interaction = baseInteraction();

    await handler(interaction);

    expect(checkReportEligibility).toHaveBeenCalledWith("session-id", "reporter", "guild");
    expect(interaction.showModal).toHaveBeenCalledOnce();
    const modal = interaction.showModal.mock.calls[0]?.[0] as { toJSON(): unknown } | undefined;
    expect(modal?.toJSON()).toMatchObject({
      custom_id: "lsreport:form:session-id",
      title: "Report Live Server"
    });
    expect(report).not.toHaveBeenCalled();
  });

  it("prevents duplicate or blacklisted reporters before opening the modal", async () => {
    const message = "You have already reported this server.";
    const handler = installRouter({ checkReportEligibility: vi.fn(() => ({ ok: false, message })) });
    const interaction = baseInteraction();

    await handler(interaction);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({ content: message, flags: MessageFlags.Ephemeral });
  });

  it("submits selected reason and details only after modal submission", async () => {
    const report = vi.fn(async () => ({ ok: true, message: "Report submitted." }));
    const handler = installRouter({ report });
    const interaction = {
      ...baseInteraction(),
      customId: "lsreport:form:session-id",
      isButton: () => false,
      isModalSubmit: () => true,
      fields: {
        getStringSelectValues: vi.fn(() => ["other"]),
        getTextInputValue: vi.fn(() => "Expired link")
      },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined)
    };

    await handler(interaction);

    expect(report).toHaveBeenCalledWith("session-id", "reporter", "guild", "other", "Expired link");
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.editReply).toHaveBeenCalledWith("Report submitted.");
  });
});
