export const SERVER_TYPES = ["carmine", "xp"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

export type Listing = {
  id: string;
  guildId: string;
  ownerId: string;
  type: ServerType;
  url: string;
  liveChannelId: string;
  liveMessageId: string | null;
  controlChannelId: string;
  controlMessageId: string | null;
  createdAt: number;
  expiresAt: number;
  active: boolean;
  cleanupPending: boolean;
  endedAt: number | null;
  endedReason: string | null;
  updatedAt: number;
};

export const LISTING_LIFETIME_MS = 2 * 60 * 60 * 1_000;
export const EXTENSION_WINDOW_MS = 10 * 60 * 1_000;
export const EXTENSION_MS = 60 * 60 * 1_000;

export function typeLabel(type: ServerType): string {
  return type === "carmine" ? "Carmine Hunt" : "XP Grinding";
}
