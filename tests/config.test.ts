import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  DISCORD_TOKEN: "test-token",
  DISCORD_CLIENT_ID: "1234567890123456789",
  DISCORD_GUILD_ID: "2234567890123456789",
  LIVE_SERVERS_CHANNEL_ID: "3234567890123456789",
  SERVER_COMMANDS_CHANNEL_ID: "4234567890123456789",
  CARMINE_ROLE_ID: "5234567890123456789",
  XP_ROLE_ID: "6234567890123456789",
  STAFF_REPORTS_CHANNEL_ID: "7234567890123456789",
  SESSION_LOGS_CHANNEL_ID: "7734567890123456789",
  MODERATOR_ROLE_ID: "8234567890123456789"
};

describe("loadConfig Discord snowflakes", () => {
  it("accepts valid 19-digit numeric snowflake IDs without numeric conversion", () => {
    const config = loadConfig(validEnv);

    expect(config.clientId).toBe(validEnv.DISCORD_CLIENT_ID);
    expect(config.guildId).toBe(validEnv.DISCORD_GUILD_ID);
    expect(config.staffReportsChannelId).toBe(validEnv.STAFF_REPORTS_CHANNEL_ID);
    expect(config.sessionLogsChannelId).toBe(validEnv.SESSION_LOGS_CHANNEL_ID);
    expect(config.moderatorRoleId).toBe(validEnv.MODERATOR_ROLE_ID);
  });

  it.each([
    "1234567890123456",
    "123456789012345678901",
    "123456789012345678x",
    "your_application_id",
    "1234 567890123456789"
  ])("rejects a non-snowflake client ID: %s", (clientId) => {
    expect(() => loadConfig({ ...validEnv, DISCORD_CLIENT_ID: clientId })).toThrow(
      /DISCORD_CLIENT_ID: must be a numeric Discord snowflake ID \(17-20 digits\)/
    );
  });

  it("requires a valid session logs channel ID", () => {
    const { SESSION_LOGS_CHANNEL_ID: _removed, ...missing } = validEnv;
    expect(() => loadConfig(missing)).toThrow(/SESSION_LOGS_CHANNEL_ID/);
    expect(() => loadConfig({ ...validEnv, SESSION_LOGS_CHANNEL_ID: "not-an-id" })).toThrow(/SESSION_LOGS_CHANNEL_ID/);
  });
});
