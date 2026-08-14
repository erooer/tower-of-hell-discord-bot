import type { Client, Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { validateStartupConfiguration } from "../src/startup-validation.js";

const config: Config = {
  token: "token", clientId: "client", guildId: "guild", liveChannelId: "live",
  commandsChannelId: "commands",
  carmineRoleId: "carmine-role", xpRoleId: "xp-role", eventRoleId: "event-role",
  staffReportsChannelId: "staff", sessionLogsChannelId: "logs", moderatorRoleId: "moderator-role",
  databasePath: ":memory:", expirationPollMs: 15_000
};

function validationClient(options: { missingChannel?: string; missingRole?: string } = {}) {
  const channelFetch = vi.fn(async (id: string) => {
    if (id === options.missingChannel) throw new Error("Unknown Channel");
    return { guildId: "guild", isTextBased: () => true, isDMBased: () => false };
  });
  const roleFetch = vi.fn(async (id: string) => id === options.missingRole ? null : { id });
  const guild = { roles: { fetch: roleFetch } } as unknown as Guild;
  const client = {
    channels: { fetch: channelFetch }, guilds: { fetch: vi.fn(async () => guild) }
  } as unknown as Client;
  return { client, channelFetch, roleFetch };
}

describe("startup Discord configuration validation", () => {
  it("validates the shared live channel as a channel and Event role as a guild role", async () => {
    const { client, channelFetch, roleFetch } = validationClient();
    await expect(validateStartupConfiguration(client, config)).resolves.toBeUndefined();
    expect(channelFetch).toHaveBeenCalledWith(config.liveChannelId);
    expect(channelFetch).not.toHaveBeenCalledWith(config.eventRoleId);
    expect(roleFetch).toHaveBeenCalledWith(config.eventRoleId);
  });

  it("labels an invalid Event role and never tries to validate it as a channel", async () => {
    const { client, channelFetch } = validationClient({ missingRole: config.eventRoleId });
    await expect(validateStartupConfiguration(client, config)).rejects.toThrow(
      "Invalid EVENT_ROLE_ID: role not found in configured guild"
    );
    expect(channelFetch).not.toHaveBeenCalledWith(config.eventRoleId);
  });
});
