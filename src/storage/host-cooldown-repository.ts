import type Database from "better-sqlite3";

export const HOST_COOLDOWN_MS = 2 * 60 * 60 * 1_000;

export type HostCooldown = {
  userId: string;
  listingId: string | null;
  successfulCreationAt: number;
  nextEligibleAt: number;
};

type HostCooldownRow = {
  user_id: string;
  listing_id: string | null;
  successful_creation_at: number;
};

export interface HostCooldownStore {
  get(userId: string): HostCooldown | null;
  recordSuccessfulCreation(userId: string, listingId: string, createdAt: number): void;
  clear?(userId: string): boolean;
}

export class HostCooldownRepository implements HostCooldownStore {
  constructor(private readonly db: Database.Database) {}

  get(userId: string): HostCooldown | null {
    const row = this.db.prepare("SELECT * FROM host_cooldowns WHERE user_id = ?").get(userId) as HostCooldownRow | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      listingId: row.listing_id,
      successfulCreationAt: row.successful_creation_at,
      nextEligibleAt: row.successful_creation_at + HOST_COOLDOWN_MS
    };
  }

  recordSuccessfulCreation(userId: string, listingId: string, createdAt: number): void {
    this.db.prepare(`INSERT INTO host_cooldowns (user_id, listing_id, successful_creation_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        listing_id = excluded.listing_id,
        successful_creation_at = excluded.successful_creation_at
      WHERE excluded.successful_creation_at >= host_cooldowns.successful_creation_at`)
      .run(userId, listingId, createdAt);
  }

  clear(userId: string): boolean {
    return this.db.prepare("DELETE FROM host_cooldowns WHERE user_id=?").run(userId).changes === 1;
  }
}
