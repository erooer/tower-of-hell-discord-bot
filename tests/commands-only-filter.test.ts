import { Events, type Client, type Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  handleCommandsOnlyMessage,
  registerCommandsOnlyFilter
} from "../src/moderation/commands-only-filter.js";

const config = {
  guildId: "guild", commandsChannelId: "commands", moderatorRoleId: "moderator-role"
} as Config;

function messageFixture(overrides: Record<string, unknown> = {}) {
  const deleteMessage = vi.fn(async () => undefined);
  const hasRole = vi.fn((_roleId: string) => false);
  const fetchMember = vi.fn(async () => ({ roles: { cache: { has: hasRole } } }));
  const message = {
    id: "message-id",
    guildId: "guild",
    channelId: "commands",
    content: "hello",
    attachments: new Map(),
    author: { id: "user-id", bot: false },
    webhookId: null,
    member: { roles: { cache: { has: hasRole } } },
    guild: { members: { fetch: fetchMember } },
    delete: deleteMessage,
    ...overrides
  } as unknown as Message;
  return { message, deleteMessage, hasRole, fetchMember };
}

describe("Session-commands commands-only filter", () => {
  it("registers one commands-only handler on Discord's MessageCreate event", async () => {
    let handler!: (message: Message) => Promise<void> | void;
    const client = { on: vi.fn((event: string, callback: typeof handler) => {
      expect(event).toBe(Events.MessageCreate);
      handler = callback;
      return client;
    }) } as unknown as Client;
    const fixture = messageFixture();

    registerCommandsOnlyFilter(client, config);
    await handler(fixture.message);

    await vi.waitFor(() => expect(fixture.deleteMessage).toHaveBeenCalledOnce());
    expect(client.on).toHaveBeenCalledOnce();
  });

  it.each([
    "anyone grinding?",
    "https://www.roblox.com/share?code=AbCdEfGh1234&type=Server",
    "/hostgrind"
  ])("silently deletes a normal member message regardless of content: %s", async (content) => {
    const fixture = messageFixture({ content });
    await handleCommandsOnlyMessage(fixture.message, config);
    expect(fixture.deleteMessage).toHaveBeenCalledOnce();
  });

  it("deletes attachment-only messages", async () => {
    const fixture = messageFixture({
      content: "",
      attachments: new Map([["attachment", { id: "attachment" }]])
    });
    await handleCommandsOnlyMessage(fixture.message, config);
    expect(fixture.deleteMessage).toHaveBeenCalledOnce();
  });

  it("allows a member with the exact configured moderator role", async () => {
    const fixture = messageFixture();
    fixture.hasRole.mockImplementation((roleId: string) => roleId === config.moderatorRoleId);
    await handleCommandsOnlyMessage(fixture.message, config);
    expect(fixture.fetchMember).toHaveBeenCalledWith("user-id");
    expect(fixture.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    { author: { id: "bot", bot: true } },
    { webhookId: "webhook-id" }
  ])("ignores bot and webhook messages", async (override) => {
    const fixture = messageFixture(override);
    await handleCommandsOnlyMessage(fixture.message, config);
    expect(fixture.fetchMember).not.toHaveBeenCalled();
    expect(fixture.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    { channelId: "general" },
    { guildId: "other-guild" }
  ])("leaves messages outside the configured guild/channel untouched", async (override) => {
    const fixture = messageFixture(override);
    await handleCommandsOnlyMessage(fixture.message, config);
    expect(fixture.fetchMember).not.toHaveBeenCalled();
    expect(fixture.deleteMessage).not.toHaveBeenCalled();
  });

  it("logs deletion failures internally without throwing or sending channel messages", async () => {
    const fixture = messageFixture();
    fixture.deleteMessage.mockRejectedValue(new Error("Missing Manage Messages"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(handleCommandsOnlyMessage(fixture.message, config)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      "Failed to delete a normal message from Session-commands",
      expect.objectContaining({ userId: "user-id", messageId: "message-id" })
    );
    error.mockRestore();
  });
});
