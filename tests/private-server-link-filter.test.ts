import { Events, type Client, type Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { sessionLogMessage, type SessionLogger } from "../src/logging/session-logger.js";
import {
  handlePrivateServerLinkMessage,
  PRIVATE_SERVER_LINK_WARNING,
  registerPrivateServerLinkFilter
} from "../src/moderation/private-server-link-filter.js";

const config = {
  guildId: "guild", commandsChannelId: "commands", moderatorRoleId: "moderator-role"
} as Config;
const now = 1_800_000_000_000;
const privateLink = "https://www.roblox.com/share?code=AbCdEfGh1234&type=Server";

function messageFixture(overrides: Record<string, unknown> = {}) {
  const deleteMessage = vi.fn(async () => undefined);
  const send = vi.fn(async () => ({ id: "warning" }));
  const hasRole = vi.fn((_roleId: string) => false);
  const fetchMember = vi.fn(async () => ({ roles: { cache: { has: hasRole } } }));
  const message = {
    id: "message-id",
    guildId: "guild",
    channelId: "commands",
    content: `Join me: ${privateLink}`,
    author: { id: "user-id", bot: false },
    webhookId: null,
    member: { roles: { cache: { has: hasRole } } },
    guild: { members: { fetch: fetchMember } },
    channel: { isSendable: () => true, send },
    delete: deleteMessage,
    ...overrides
  } as unknown as Message;
  return { message, deleteMessage, send, hasRole, fetchMember };
}

function loggerFixture() {
  return { log: vi.fn(async () => undefined) } as unknown as SessionLogger & { log: ReturnType<typeof vi.fn> };
}

describe("Session-commands private-server link filter", () => {
  it("registers the filter on Discord's MessageCreate event", async () => {
    let handler!: (message: Message) => Promise<void> | void;
    const client = { on: vi.fn((event: string, callback: typeof handler) => {
      expect(event).toBe(Events.MessageCreate);
      handler = callback;
      return client;
    }) } as unknown as Client;
    const fixture = messageFixture();
    const logger = loggerFixture();
    registerPrivateServerLinkFilter(client, config, logger, () => now);
    await handler(fixture.message);
    await vi.waitFor(() => expect(fixture.deleteMessage).toHaveBeenCalledOnce());
  });

  it.each([
    privateLink,
    "Try <https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=AbCdEfGh1234>."
  ])("deletes a regular user's supported private-server link and sends the warning", async (content) => {
    const { message, deleteMessage, send } = messageFixture({ content });
    const logger = loggerFixture();
    await handlePrivateServerLinkMessage(message, config, logger, () => now);

    expect(deleteMessage).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      content: PRIVATE_SERVER_LINK_WARNING,
      allowedMentions: { users: [], roles: [], repliedUser: false }
    });
    expect(logger.log).toHaveBeenCalledWith({
      kind: "blocked-private-server-link", userId: "user-id", occurredAt: now
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(privateLink);
  });

  it.each([
    "Normal conversation",
    "https://www.roblox.com/games/1962086868/Tower-of-Hell",
    "https://www.roblox.com/users/123/profile"
  ])("leaves normal text and non-private Roblox links untouched", async (content) => {
    const { message, deleteMessage, send, fetchMember } = messageFixture({ content });
    const logger = loggerFixture();
    await handlePrivateServerLinkMessage(message, config, logger, () => now);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetchMember).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("leaves the same private-server link untouched outside Session-commands", async () => {
    const { message, deleteMessage, send } = messageFixture({ channelId: "general" });
    const logger = loggerFixture();
    await handlePrivateServerLinkMessage(message, config, logger, () => now);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("allows a member with the exact configured moderator role", async () => {
    const fixture = messageFixture();
    fixture.hasRole.mockImplementation((roleId: string) => roleId === config.moderatorRoleId);
    const logger = loggerFixture();
    await handlePrivateServerLinkMessage(fixture.message, config, logger, () => now);
    expect(fixture.deleteMessage).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it.each([
    { author: { id: "bot", bot: true } },
    { webhookId: "webhook-id" }
  ])("ignores bot and webhook messages", async (override) => {
    const { message, deleteMessage, send } = messageFixture(override);
    const logger = loggerFixture();
    await handlePrivateServerLinkMessage(message, config, logger, () => now);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("continues with warning and logging when deletion fails", async () => {
    const fixture = messageFixture();
    fixture.deleteMessage.mockRejectedValue(new Error("Missing Manage Messages"));
    const logger = loggerFixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(handlePrivateServerLinkMessage(fixture.message, config, logger, () => now)).resolves.toBeUndefined();
    expect(fixture.send).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Failed to delete a private-server link from Session-commands",
      expect.objectContaining({ userId: "user-id", messageId: "message-id" })
    );
    error.mockRestore();
  });

  it("continues and logs internally when the warning cannot be sent", async () => {
    const fixture = messageFixture();
    fixture.send.mockRejectedValue(new Error("Missing Send Messages"));
    const logger = loggerFixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(handlePrivateServerLinkMessage(fixture.message, config, logger, () => now)).resolves.toBeUndefined();
    expect(fixture.deleteMessage).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "Failed to send the private-server link warning",
      expect.objectContaining({ userId: "user-id", messageId: "message-id" })
    );
    error.mockRestore();
  });

  it("builds a private moderation log without including the URL", () => {
    const payload = sessionLogMessage({
      kind: "blocked-private-server-link", userId: "user-id", occurredAt: now
    });
    const json = JSON.stringify(payload);
    expect(json).toContain("Private Server Link Blocked");
    expect(json).toContain("<@user-id>");
    expect(json).toContain("`user-id`");
    expect(json).toContain("<t:1800000000:F>");
    expect(json).not.toContain("roblox.com");
    expect(payload.allowedMentions).toEqual({ users: [], roles: [], repliedUser: false });
  });
});
