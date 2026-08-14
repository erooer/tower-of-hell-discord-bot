import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Listing } from "../live-servers/model.js";
import {
  REPORT_THRESHOLD,
  type CaseStatus,
  type ModerationCase,
  type ReporterSummary,
  type ReportReason,
  type ReasonSummary
} from "../moderation/model.js";
import { HOST_COOLDOWN_MS } from "./host-cooldown-repository.js";

type CaseRow = {
  session_id: string; staff_channel_id: string; staff_message_id: string | null;
  urgent_message_id: string | null; urgent_escalated_at: number | null; urgent_pinged_at: number | null;
  escalated_at: number; status: CaseStatus; resolved_by: string | null;
  resolved_at: number | null; updated_at: number;
};

function mapCase(row: CaseRow): ModerationCase {
  return {
    sessionId: row.session_id,
    staffChannelId: row.staff_channel_id,
    staffMessageId: row.staff_message_id,
    urgentMessageId: row.urgent_message_id,
    urgentEscalatedAt: row.urgent_escalated_at,
    urgentPingedAt: row.urgent_pinged_at,
    escalatedAt: row.escalated_at,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at
  };
}

export type SubmitReportResult =
  | { ok: false; reason: "blacklisted" | "duplicate" }
  | { ok: true; count: number; escalatedNow: boolean; moderationCase: ModerationCase | null };

export type ResolveCaseResult =
  | { ok: false; reason: "missing" | "resolved" }
  | {
      ok: true; moderationCase: ModerationCase; strikeCount: number;
      hostBlacklisted: boolean; hostBlacklistedNow: boolean;
    };

export type HostModerationStatus = {
  strikeCount: number;
  latestActiveStrikeId: string | null;
  latestStrikeAt: number | null;
  hostBlacklisted: boolean;
  hostBlacklistedAt: number | null;
  reporterBlacklisted: boolean;
  reporterBlacklistedAt: number | null;
  reportHistory: { total: number; valid: number; rejected: number };
};

export type StatusAuditEntry = {
  action: "strike_added" | "strike_revoked"
    | "host_blacklist_added" | "host_blacklist_removed"
    | "reporter_blacklist_added" | "reporter_blacklist_removed"
    | "cooldown_added" | "cooldown_cleared";
  moderatorId: string;
  relatedId: string | null;
  createdAt: number;
};

export class ModerationRepository {
  constructor(private readonly db: Database.Database) {}

  isReporterBlacklisted(userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM reporter_blacklist WHERE user_id=? AND removed_at IS NULL").get(userId));
  }

  isHostBlacklisted(userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM host_blacklist WHERE user_id=? AND removed_at IS NULL").get(userId));
  }

  submitReport(
    listing: Listing,
    reporterId: string,
    staffChannelId: string,
    now: number,
    reason: ReportReason | null = null,
    details: string | null = null
  ): SubmitReportResult {
    return this.db.transaction((): SubmitReportResult => {
      if (this.isReporterBlacklisted(reporterId)) return { ok: false, reason: "blacklisted" };
      const existingCase = this.getCase(listing.id);
      const outcome = existingCase?.status === "ignored"
        ? "rejected"
        : existingCase?.status === "struck" ? "valid" : "pending";
      const decidedAt = outcome === "pending" ? null : now;
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO live_server_reports
        (session_id,reporter_id,host_id,reported_at,report_reason,additional_details,outcome,decided_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(listing.id, reporterId, listing.ownerId, now, reason, details, outcome, decidedAt);
      if (inserted.changes !== 1) return { ok: false, reason: "duplicate" };

      this.db.prepare(`INSERT OR IGNORE INTO moderation_cases
        (session_id,staff_channel_id,escalated_at,status,updated_at) VALUES (?, ?, ?, 'open', ?)`)
        .run(listing.id, staffChannelId, now, now);

      const count = this.getReportCount(listing.id);
      let escalatedNow = false;
      const moderationCase = this.getCase(listing.id)!;
      if (count >= REPORT_THRESHOLD && moderationCase.status === "open") {
        const escalated = this.db.prepare(`UPDATE moderation_cases
          SET urgent_escalated_at=?, updated_at=?
          WHERE session_id=? AND urgent_escalated_at IS NULL`)
          .run(now, now, listing.id);
        escalatedNow = escalated.changes === 1;
      }
      return { ok: true, count, escalatedNow, moderationCase: this.getCase(listing.id) };
    })();
  }

  getReportCount(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM live_server_reports WHERE session_id=?")
      .get(sessionId) as { count: number };
    return row.count;
  }

  getCase(sessionId: string): ModerationCase | null {
    const row = this.db.prepare("SELECT * FROM moderation_cases WHERE session_id=?").get(sessionId) as CaseRow | undefined;
    return row ? mapCase(row) : null;
  }

  listCases(): ModerationCase[] {
    return (this.db.prepare("SELECT * FROM moderation_cases ORDER BY escalated_at").all() as CaseRow[]).map(mapCase);
  }

  setCaseMessage(sessionId: string, messageId: string | null, now: number): void {
    this.db.prepare("UPDATE moderation_cases SET staff_message_id=?, updated_at=? WHERE session_id=?")
      .run(messageId, now, sessionId);
  }

  setUrgentMessage(sessionId: string, messageId: string | null, now: number): void {
    this.db.prepare("UPDATE moderation_cases SET urgent_message_id=?, updated_at=? WHERE session_id=?")
      .run(messageId, now, sessionId);
  }

  claimUrgentPing(sessionId: string, now: number): boolean {
    return this.db.prepare(`UPDATE moderation_cases SET urgent_pinged_at=?, updated_at=?
      WHERE session_id=? AND urgent_escalated_at IS NOT NULL AND urgent_pinged_at IS NULL`)
      .run(now, now, sessionId).changes === 1;
  }

  getReporterSummaries(sessionId: string): ReporterSummary[] {
    return this.db.prepare(`SELECT r.reporter_id AS userId, r.reported_at AS reportedAt,
      r.report_reason AS reason, r.additional_details AS details,
      COUNT(all_r.session_id) AS total,
      SUM(CASE WHEN all_r.outcome='valid' THEN 1 ELSE 0 END) AS valid,
      SUM(CASE WHEN all_r.outcome='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM live_server_reports r
      JOIN live_server_reports all_r ON all_r.reporter_id=r.reporter_id
      WHERE r.session_id=?
      GROUP BY r.reporter_id, r.reported_at
      ORDER BY r.reported_at, r.reporter_id`).all(sessionId) as ReporterSummary[];
  }

  getReasonCounts(sessionId: string): ReasonSummary[] {
    return this.db.prepare(`SELECT report_reason AS reason, COUNT(*) AS count
      FROM live_server_reports WHERE session_id=?
      GROUP BY report_reason ORDER BY count DESC, report_reason`).all(sessionId) as ReasonSummary[];
  }

  hasReported(sessionId: string, reporterId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM live_server_reports WHERE session_id=? AND reporter_id=?")
      .get(sessionId, reporterId));
  }

  reporterHistory(userId: string): { total: number; valid: number; rejected: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN outcome='valid' THEN 1 ELSE 0 END) AS valid,
      SUM(CASE WHEN outcome='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM live_server_reports WHERE reporter_id=?`).get(userId) as { total: number; valid: number | null; rejected: number | null };
    return { total: row.total, valid: row.valid ?? 0, rejected: row.rejected ?? 0 };
  }

  blacklistReporter(userId: string, moderatorId: string, reason: string | null, now: number): boolean {
    return this.db.prepare(`INSERT INTO reporter_blacklist
      (user_id,blacklisted_at,moderator_id,reason,removed_at,removed_by) VALUES (?,?,?,?,NULL,NULL)
      ON CONFLICT(user_id) DO UPDATE SET
        blacklisted_at=excluded.blacklisted_at, moderator_id=excluded.moderator_id,
        reason=excluded.reason, removed_at=NULL, removed_by=NULL
      WHERE reporter_blacklist.removed_at IS NOT NULL`)
      .run(userId, now, moderatorId, reason).changes === 1;
  }

  isReporterOnCase(sessionId: string, reporterId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM live_server_reports WHERE session_id=? AND reporter_id=?")
      .get(sessionId, reporterId));
  }

  getHostStrikeCount(hostId: string): number {
    const row = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM host_strikes WHERE host_id=? AND active=1) +
      (SELECT COUNT(*) FROM host_status_strikes WHERE host_id=? AND active=1) AS count`)
      .get(hostId, hostId) as { count: number };
    return row.count;
  }

  getHostModerationStatus(userId: string): HostModerationStatus {
    const latestStrike = this.db.prepare(`SELECT id, created_at FROM (
        SELECT id,created_at FROM host_strikes WHERE host_id=?
        UNION ALL SELECT id,created_at FROM host_status_strikes WHERE host_id=?
      ) ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(userId, userId) as { id: string; created_at: number } | undefined;
    const latestActiveStrike = this.db.prepare(`SELECT id FROM (
        SELECT id,created_at FROM host_strikes WHERE host_id=? AND active=1
        UNION ALL SELECT id,created_at FROM host_status_strikes WHERE host_id=? AND active=1
      ) ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(userId, userId) as { id: string } | undefined;
    const hostBlacklist = this.db.prepare(`SELECT blacklisted_at, removed_at FROM host_blacklist
      WHERE user_id=?`).get(userId) as { blacklisted_at: number; removed_at: number | null } | undefined;
    const reporterBlacklist = this.db.prepare(`SELECT blacklisted_at, removed_at FROM reporter_blacklist
      WHERE user_id=?`).get(userId) as { blacklisted_at: number; removed_at: number | null } | undefined;
    return {
      strikeCount: this.getHostStrikeCount(userId),
      latestActiveStrikeId: latestActiveStrike?.id ?? null,
      latestStrikeAt: latestStrike?.created_at ?? null,
      hostBlacklisted: Boolean(hostBlacklist && hostBlacklist.removed_at === null),
      hostBlacklistedAt: hostBlacklist?.removed_at === null ? hostBlacklist.blacklisted_at : null,
      reporterBlacklisted: Boolean(reporterBlacklist && reporterBlacklist.removed_at === null),
      reporterBlacklistedAt: reporterBlacklist?.removed_at === null ? reporterBlacklist.blacklisted_at : null,
      reportHistory: this.reporterHistory(userId)
    };
  }

  revokeStrike(userId: string, strikeId: string, moderatorId: string, now: number): boolean {
    return this.db.transaction(() => {
      let changed = this.db.prepare(`UPDATE host_strikes
        SET active=0, revoked_at=?, revoked_by=?
        WHERE id=? AND host_id=? AND active=1`)
        .run(now, moderatorId, strikeId, userId);
      if (changed.changes !== 1) {
        changed = this.db.prepare(`UPDATE host_status_strikes
          SET active=0, revoked_at=?, revoked_by=?
          WHERE id=? AND host_id=? AND active=1`)
          .run(now, moderatorId, strikeId, userId);
      }
      if (changed.changes !== 1) return false;
      this.insertStatusAudit(userId, "strike_revoked", moderatorId, strikeId, now);
      if (this.getHostStrikeCount(userId) < 3) {
        const blacklistRemoved = this.db.prepare(`UPDATE host_blacklist
          SET removed_at=?, removed_by=?
          WHERE user_id=? AND removed_at IS NULL AND source='strikes'`)
          .run(now, moderatorId, userId);
        if (blacklistRemoved.changes === 1) {
          this.insertStatusAudit(userId, "host_blacklist_removed", moderatorId, null, now);
        }
      }
      return true;
    })();
  }

  addHostStrike(userId: string, moderatorId: string, now: number, expectedCount: number): boolean {
    return this.db.transaction(() => {
      const count = this.getHostStrikeCount(userId);
      if (count !== expectedCount || count >= 3) return false;
      const strikeId = randomUUID();
      this.db.prepare(`INSERT INTO host_status_strikes
        (id,host_id,moderator_id,created_at,active) VALUES (?,?,?,?,1)`)
        .run(strikeId, userId, moderatorId, now);
      this.insertStatusAudit(userId, "strike_added", moderatorId, strikeId, now);
      if (count + 1 >= 3) this.addHostBlacklistInternal(userId, moderatorId, now, "strikes");
      return true;
    })();
  }

  addHostBlacklist(userId: string, moderatorId: string, now: number): boolean {
    return this.db.transaction(() => this.addHostBlacklistInternal(userId, moderatorId, now, "manual"))();
  }

  private addHostBlacklistInternal(userId: string, moderatorId: string, now: number, source: "strikes" | "manual"): boolean {
    const changed = this.db.prepare(`INSERT INTO host_blacklist
      (user_id,blacklisted_at,triggering_session_id,moderator_id,source,removed_at,removed_by)
      VALUES (?,?,NULL,?,?,NULL,NULL)
      ON CONFLICT(user_id) DO UPDATE SET blacklisted_at=excluded.blacklisted_at,
        triggering_session_id=NULL,moderator_id=excluded.moderator_id,source=excluded.source,
        removed_at=NULL,removed_by=NULL WHERE host_blacklist.removed_at IS NOT NULL`)
      .run(userId, now, moderatorId, source);
    if (changed.changes === 1) this.insertStatusAudit(userId, "host_blacklist_added", moderatorId, null, now);
    return changed.changes === 1;
  }

  addReporterBlacklist(userId: string, moderatorId: string, now: number): boolean {
    const changed = this.blacklistReporter(userId, moderatorId, "Added through /hoststatus", now);
    if (changed) this.insertStatusAudit(userId, "reporter_blacklist_added", moderatorId, null, now);
    return changed;
  }

  addHostCooldown(userId: string, moderatorId: string, now: number): boolean {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT successful_creation_at FROM host_cooldowns WHERE user_id=?")
        .get(userId) as { successful_creation_at: number } | undefined;
      if (existing && existing.successful_creation_at > now - HOST_COOLDOWN_MS) return false;
      this.db.prepare(`INSERT INTO host_cooldowns (user_id,listing_id,successful_creation_at)
        VALUES (?,NULL,?) ON CONFLICT(user_id) DO UPDATE SET listing_id=NULL,
        successful_creation_at=excluded.successful_creation_at`).run(userId, now);
      this.insertStatusAudit(userId, "cooldown_added", moderatorId, null, now);
      return true;
    })();
  }

  removeHostBlacklist(userId: string, moderatorId: string, now: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE host_blacklist SET removed_at=?, removed_by=?
        WHERE user_id=? AND removed_at IS NULL`).run(now, moderatorId, userId);
      if (changed.changes !== 1) return false;
      this.insertStatusAudit(userId, "host_blacklist_removed", moderatorId, null, now);
      return true;
    })();
  }

  removeReporterBlacklist(userId: string, moderatorId: string, now: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE reporter_blacklist SET removed_at=?, removed_by=?
        WHERE user_id=? AND removed_at IS NULL`).run(now, moderatorId, userId);
      if (changed.changes !== 1) return false;
      this.insertStatusAudit(userId, "reporter_blacklist_removed", moderatorId, null, now);
      return true;
    })();
  }

  clearHostCooldown(userId: string, moderatorId: string, now: number, expectedCreatedAt?: number): boolean {
    return this.db.transaction(() => {
      const changed = expectedCreatedAt === undefined
        ? this.db.prepare("DELETE FROM host_cooldowns WHERE user_id=?").run(userId)
        : this.db.prepare("DELETE FROM host_cooldowns WHERE user_id=? AND successful_creation_at=?")
          .run(userId, expectedCreatedAt);
      if (changed.changes !== 1) return false;
      this.insertStatusAudit(userId, "cooldown_cleared", moderatorId, null, now);
      return true;
    })();
  }

  listStatusAudit(userId: string): StatusAuditEntry[] {
    return this.db.prepare(`SELECT action, moderator_id AS moderatorId,
      related_id AS relatedId, created_at AS createdAt
      FROM moderation_status_audit WHERE user_id=? ORDER BY created_at, id`)
      .all(userId) as StatusAuditEntry[];
  }

  private insertStatusAudit(
    userId: string,
    action: StatusAuditEntry["action"],
    moderatorId: string,
    relatedId: string | null,
    now: number
  ): void {
    this.db.prepare(`INSERT INTO moderation_status_audit
      (id,user_id,action,moderator_id,related_id,created_at) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), userId, action, moderatorId, relatedId, now);
  }

  resolveCase(sessionId: string, action: "ignore" | "strike", moderatorId: string, now: number): ResolveCaseResult {
    return this.db.transaction((): ResolveCaseResult => {
      const moderationCase = this.getCase(sessionId);
      if (!moderationCase) return { ok: false, reason: "missing" };
      if (moderationCase.status !== "open") return { ok: false, reason: "resolved" };
      const listing = this.db.prepare("SELECT owner_id FROM live_server_listings WHERE id=?")
        .get(sessionId) as { owner_id: string } | undefined;
      if (!listing) return { ok: false, reason: "missing" };

      const status: CaseStatus = action === "strike" ? "struck" : "ignored";
      const changed = this.db.prepare(`UPDATE moderation_cases SET status=?,resolved_by=?,resolved_at=?,updated_at=?
        WHERE session_id=? AND status='open'`).run(status, moderatorId, now, now, sessionId);
      if (changed.changes !== 1) return { ok: false, reason: "resolved" };
      this.db.prepare(`UPDATE live_server_reports SET outcome=?,decided_at=?
        WHERE session_id=? AND outcome='pending'`).run(action === "strike" ? "valid" : "rejected", now, sessionId);

      if (action === "strike") {
        this.db.prepare(`INSERT OR IGNORE INTO host_strikes
          (id,host_id,session_id,moderator_id,created_at,active) VALUES (?,?,?,?,?,1)`)
          .run(randomUUID(), listing.owner_id, sessionId, moderatorId, now);
      }
      const strikeCount = this.getHostStrikeCount(listing.owner_id);
      let hostBlacklistedNow = false;
      if (strikeCount >= 3) {
        const blacklisted = this.db.prepare(`INSERT INTO host_blacklist
          (user_id,blacklisted_at,triggering_session_id,moderator_id,source,removed_at,removed_by)
          VALUES (?,?,?,?,'strikes',NULL,NULL)
          ON CONFLICT(user_id) DO UPDATE SET
            blacklisted_at=excluded.blacklisted_at,
            triggering_session_id=excluded.triggering_session_id,
            moderator_id=excluded.moderator_id,
            source='strikes', removed_at=NULL, removed_by=NULL
          WHERE host_blacklist.removed_at IS NOT NULL`)
          .run(listing.owner_id, now, sessionId, moderatorId);
        hostBlacklistedNow = blacklisted.changes === 1;
      }
      return {
        ok: true,
        moderationCase: this.getCase(sessionId)!,
        strikeCount,
        hostBlacklisted: this.isHostBlacklisted(listing.owner_id),
        hostBlacklistedNow
      };
    })();
  }
}
