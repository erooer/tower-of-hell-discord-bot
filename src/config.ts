import "dotenv/config";
import { z } from "zod";

// Discord snowflakes are decimal identifiers. Keep them as strings so JavaScript
// never loses precision; current IDs are typically 18–19 digits, while the
// supported Discord snowflake range is 17–20 ASCII digits.
const snowflake = z
  .string()
  .regex(/^[0-9]{17,20}$/, "must be a numeric Discord snowflake ID (17-20 digits)");

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  LIVE_SERVERS_CHANNEL_ID: snowflake,
  SERVER_COMMANDS_CHANNEL_ID: snowflake,
  CARMINE_ROLE_ID: snowflake,
  XP_ROLE_ID: snowflake,
  DATABASE_PATH: z.string().min(1).default("./data/live-servers.sqlite"),
  EXPIRATION_POLL_MS: z.coerce.number().int().min(5_000).default(15_000)
});

export type Config = {
  token: string;
  clientId: string;
  guildId: string;
  liveChannelId: string;
  commandsChannelId: string;
  carmineRoleId: string;
  xpRoleId: string;
  databasePath: string;
  expirationPollMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }
  const value = result.data;
  return {
    token: value.DISCORD_TOKEN,
    clientId: value.DISCORD_CLIENT_ID,
    guildId: value.DISCORD_GUILD_ID,
    liveChannelId: value.LIVE_SERVERS_CHANNEL_ID,
    commandsChannelId: value.SERVER_COMMANDS_CHANNEL_ID,
    carmineRoleId: value.CARMINE_ROLE_ID,
    xpRoleId: value.XP_ROLE_ID,
    databasePath: value.DATABASE_PATH,
    expirationPollMs: value.EXPIRATION_POLL_MS
  };
}
