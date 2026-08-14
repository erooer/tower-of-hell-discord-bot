import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { EXTENSION_MS, EXTENSION_WINDOW_MS, type Listing, type ServerType } from "../live-servers/model.js";

type ListingRow = {
  id: string; guild_id: string; owner_id: string; type: ServerType; url: string;
  host_source: Listing["hostSource"]; host_message: string | null;
  live_channel_id: string; live_message_id: string | null; control_channel_id: string;
  control_message_id: string | null; created_at: number; expires_at: number; active: number;
  cleanup_pending: number; ended_at: number | null; ended_reason: string | null; updated_at: number;
};

function map(row: ListingRow): Listing {
  return {
    id: row.id, guildId: row.guild_id, ownerId: row.owner_id, type: row.type, url: row.url,
    hostSource: row.host_source, hostMessage: row.host_message,
    liveChannelId: row.live_channel_id, liveMessageId: row.live_message_id,
    controlChannelId: row.control_channel_id, controlMessageId: row.control_message_id,
    createdAt: row.created_at, expiresAt: row.expires_at, active: Boolean(row.active),
    cleanupPending: Boolean(row.cleanup_pending), endedAt: row.ended_at,
    endedReason: row.ended_reason, updatedAt: row.updated_at
  };
}

export type ExtendResult =
  | { ok: true; listing: Listing }
  | { ok: false; reason: "missing" | "inactive" | "expired" | "too_early" };

type CreateListingInput = Omit<Listing,
  "id" | "active" | "cleanupPending" | "endedAt" | "endedReason" | "updatedAt" | "hostSource" | "hostMessage">
  & Partial<Pick<Listing, "hostSource" | "hostMessage">>;

export class ListingRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateListingInput): Listing {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO live_server_listings
      (id,guild_id,owner_id,type,host_source,host_message,url,live_channel_id,live_message_id,control_channel_id,control_message_id,created_at,expires_at,active,cleanup_pending,updated_at)
      VALUES (@id,@guildId,@ownerId,@type,@hostSource,@hostMessage,@url,@liveChannelId,@liveMessageId,@controlChannelId,@controlMessageId,@createdAt,@expiresAt,1,0,@createdAt)`)
      .run({ id, hostSource: "self", hostMessage: null, ...input });
    return this.get(id)!;
  }

  get(id: string): Listing | null {
    const row = this.db.prepare("SELECT * FROM live_server_listings WHERE id = ?").get(id) as ListingRow | undefined;
    return row ? map(row) : null;
  }

  getActiveForOwner(guildId: string, ownerId: string, type: ServerType): Listing | null {
    const row = this.db.prepare("SELECT * FROM live_server_listings WHERE guild_id=? AND owner_id=? AND type=? AND active=1")
      .get(guildId, ownerId, type) as ListingRow | undefined;
    return row ? map(row) : null;
  }

  getActiveByLiveMessage(messageId: string): Listing | null {
    const row = this.db.prepare("SELECT * FROM live_server_listings WHERE live_message_id=? AND active=1")
      .get(messageId) as ListingRow | undefined;
    return row ? map(row) : null;
  }

  listActive(): Listing[] {
    return (this.db.prepare("SELECT * FROM live_server_listings WHERE active=1 ORDER BY expires_at").all() as ListingRow[]).map(map);
  }

  listCleanupPending(): Listing[] {
    return (this.db.prepare("SELECT * FROM live_server_listings WHERE cleanup_pending=1").all() as ListingRow[]).map(map);
  }

  setMessageIds(id: string, liveMessageId: string | null, controlMessageId: string | null, now: number): void {
    this.db.prepare("UPDATE live_server_listings SET live_message_id=?, control_message_id=?, updated_at=? WHERE id=?")
      .run(liveMessageId, controlMessageId, now, id);
  }

  setControlMessageId(id: string, messageId: string, now: number): void {
    this.db.prepare("UPDATE live_server_listings SET control_message_id=?, updated_at=? WHERE id=?")
      .run(messageId, now, id);
  }

  updateUrl(id: string, url: string, now: number): Listing | null {
    this.db.prepare("UPDATE live_server_listings SET url=?, updated_at=? WHERE id=? AND active=1").run(url, now, id);
    return this.get(id);
  }

  extend(id: string, now: number): ExtendResult {
    return this.db.transaction((): ExtendResult => {
      const listing = this.get(id);
      if (!listing) return { ok: false, reason: "missing" };
      if (!listing.active) return { ok: false, reason: "inactive" };
      if (listing.expiresAt <= now) return { ok: false, reason: "expired" };
      if (listing.expiresAt - now > EXTENSION_WINDOW_MS) return { ok: false, reason: "too_early" };
      const next = listing.expiresAt + EXTENSION_MS;
      const changed = this.db.prepare("UPDATE live_server_listings SET expires_at=?, updated_at=? WHERE id=? AND active=1 AND expires_at=?")
        .run(next, now, id, listing.expiresAt);
      if (changed.changes !== 1) return { ok: false, reason: "inactive" };
      return { ok: true, listing: this.get(id)! };
    })();
  }

  deactivate(id: string, reason: string, now: number): Listing | null {
    this.db.prepare(`UPDATE live_server_listings SET active=0, cleanup_pending=1,
      ended_at=COALESCE(ended_at, ?), ended_reason=COALESCE(ended_reason, ?), updated_at=?
      WHERE id=? AND active=1`).run(now, reason, now, id);
    return this.get(id);
  }

  claimIfExpired(id: string, now: number): Listing | null {
    const result = this.db.prepare(`UPDATE live_server_listings SET active=0, cleanup_pending=1,
      ended_at=?, ended_reason='expired', updated_at=? WHERE id=? AND active=1 AND expires_at<=?`)
      .run(now, now, id, now);
    return result.changes === 1 ? this.get(id) : null;
  }

  finishCleanup(id: string, now: number): void {
    this.db.prepare("UPDATE live_server_listings SET cleanup_pending=0, updated_at=? WHERE id=?").run(now, id);
  }
}
