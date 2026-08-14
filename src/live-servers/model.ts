export const SERVER_TYPES = ["carmine", "xp", "event"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

export function isServerType(value: string): value is ServerType {
  return SERVER_TYPES.includes(value as ServerType);
}

export const SERVER_TYPE_PRESENTATION: Record<ServerType, {
  label: string;
  activity: string;
  announcementTitle: string;
  announcementDescription?: string;
  color: number;
  modalTitle: string;
}> = {
  carmine: {
    label: "Carmine Hunt", activity: "🔥 Carmine Hunting", announcementTitle: "🔥 Carmine Hunting",
    color: 0xb51f42, modalTitle: "Start a Carmine Hunt"
  },
  xp: {
    label: "XP Grinding", activity: "⚡ XP Grinding", announcementTitle: "⚡ XP Grinding Server",
    color: 0x35a7ff, modalTitle: "Start XP Grinding"
  },
  event: {
    label: "Event", activity: "Event", announcementTitle: "Event Session",
    announcementDescription: "An event is currently being hosted!", color: 0x9b59b6,
    modalTitle: "Start an Event"
  }
};

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
export const EXTENSION_WINDOW_MS = 30 * 60 * 1_000;
export const EXTENSION_MS = 60 * 60 * 1_000;

export function typeLabel(type: ServerType): string {
  return SERVER_TYPE_PRESENTATION[type].label;
}
