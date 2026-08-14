import { Events, MessageFlags, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { liveServerCommands } from "../src/commands/live-server-commands.js";
import { hostGrindSelector } from "../src/interactions/host-grind.js";
import { registerInteractionRouter } from "../src/interactions/router.js";
import type { Config } from "../src/config.js";
import type { LiveServerService } from "../src/live-servers/service.js";
import type { ModerationService } from "../src/moderation/service.js";

const config = { guildId: "guild", commandsChannelId: "commands", moderatorRoleId: "moderator-role" } as Config;

function installRouter(service: Partial<LiveServerService>) {
  let handler!: (interaction: any) => Promise<void>;
  const client = {
    on: vi.fn((event: string, callback: typeof handler) => {
      if (event === Events.InteractionCreate) handler = callback;
      return client;
    })
  } as unknown as Client;
  registerInteractionRouter(client, service as LiveServerService, {} as ModerationService, config);
  return handler;
}

function classifiers(kind: "command" | "select" | "button") {
  return {
    isChatInputCommand: () => kind === "command",
    isStringSelectMenu: () => kind === "select",
    isButton: () => kind === "button",
    isModalSubmit: () => false,
    isRepliable: () => true
  };
}

describe("/hostgrind interactions", () => {
  it("keeps /hostgrind registered without restoring the retired commands", () => {
    expect(liveServerCommands.map((command) => command.name)).toContain("hostgrind");
    expect(liveServerCommands.map((command) => command.name)).not.toContain("carmine");
    expect(liveServerCommands.map((command) => command.name)).not.toContain("xp");
  });

  it("offers Carmine Hunting and XP Grinding", () => {
    const payload = JSON.parse(JSON.stringify(hostGrindSelector()));
    expect(payload.components[0].components[0]).toMatchObject({
      custom_id: "lshost:type",
      options: [
        { label: "Carmine Hunting", value: "carmine" },
        { label: "XP Grinding", value: "xp" }
      ]
    });
  });

  it("opening /hostgrind checks eligibility and shows the selector without creating a server", async () => {
    const checkHostingEligibility = vi.fn(() => ({ ok: true as const }));
    const create = vi.fn();
    const handler = installRouter({ checkHostingEligibility, create });
    const reply = vi.fn(async (_payload: unknown) => undefined);
    await handler({
      ...classifiers("command"), commandName: "hostgrind", channelId: "commands", guildId: "guild",
      user: { id: "host" }, reply, followUp: vi.fn(), deferred: false, replied: false
    });

    expect(checkHostingEligibility).toHaveBeenCalledWith("host", false);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("lshost:type");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["carmine", "lsv1:create:carmine", "Start a Carmine Hunt"],
    ["xp", "lsv1:create:xp", "Start XP Grinding"]
  ])("selecting %s opens its existing creation modal without creating yet", async (type, customId, title) => {
    const checkCreationEligibility = vi.fn(() => ({ ok: true as const }));
    const create = vi.fn();
    const handler = installRouter({ checkCreationEligibility, create });
    const showModal = vi.fn(async (_modal: unknown) => undefined);
    await handler({
      ...classifiers("select"), customId: "lshost:type", values: [type], channelId: "commands", guildId: "guild",
      user: { id: "host" }, showModal, reply: vi.fn(), followUp: vi.fn(), deferred: false, replied: false
    });

    expect(checkCreationEligibility).toHaveBeenCalledWith("guild", "host", type, false);
    const modal = showModal.mock.calls[0]?.[0] as { toJSON(): unknown };
    expect(modal.toJSON()).toMatchObject({ custom_id: customId, title });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the persisted cooldown timestamp before showing the selector", async () => {
    const message = "You can host another server <t:1800010800:R>.";
    const handler = installRouter({ checkHostingEligibility: vi.fn(() => ({ ok: false as const, message })) });
    const reply = vi.fn(async (_payload: unknown) => undefined);
    await handler({
      ...classifiers("command"), commandName: "hostgrind", channelId: "commands", guildId: "guild",
      user: { id: "host" }, reply, followUp: vi.fn(), deferred: false, replied: false
    });
    expect(reply).toHaveBeenCalledWith({ content: message, flags: MessageFlags.Ephemeral });
  });

  it("passes exact moderator-role membership into the initial cooldown check", async () => {
    const checkHostingEligibility = vi.fn(() => ({ ok: true as const }));
    const handler = installRouter({ checkHostingEligibility });
    await handler({
      ...classifiers("command"), commandName: "hostgrind", channelId: "commands", guildId: "guild",
      user: { id: "moderator" }, member: { roles: ["moderator-role"] },
      reply: vi.fn(async (_payload: unknown) => undefined), followUp: vi.fn(), deferred: false, replied: false
    });
    expect(checkHostingEligibility).toHaveBeenCalledWith("moderator", true);
  });

  it("preserves the host blacklist check", async () => {
    const message = "You are blacklisted from creating live-server announcements. Contact a moderator to appeal.";
    const handler = installRouter({ checkHostingEligibility: vi.fn(() => ({ ok: false as const, message })) });
    const reply = vi.fn(async (_payload: unknown) => undefined);
    await handler({
      ...classifiers("command"), commandName: "hostgrind", channelId: "commands", guildId: "guild",
      user: { id: "host" }, reply, followUp: vi.fn(), deferred: false, replied: false
    });
    expect(reply).toHaveBeenCalledWith({ content: message, flags: MessageFlags.Ephemeral });
  });
});
