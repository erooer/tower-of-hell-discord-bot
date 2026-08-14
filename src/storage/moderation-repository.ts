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

type CaseRow = {
  session_id: string; staff_channel_id: string; staff_message_id: string | null;
  escalated_at: number; status: CaseStatus; resolved_by: string | null;
  resolved_at: number | null; updated_at: number;
};

function mapCase(row: CaseRow): ModerationCase {
  return {
    sessionId: row.session_id,
    staffChannelId: row.staff_channel_id,
    staffMessageId: row.staff_message_id,
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
  | { ok: true; moderationCase: ModerationCase; strikeCount: number; hostBlacklisted: boolean };

export class ModerationRepository {
  constructor(private readonly db: Database.Database) {}

  isReporterBlacklisted(userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM reporter_blacklist WHERE user_id=?").get(userId));
  }

  isHostBlacklisted(userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM host_blacklist WHERE user_id=?").get(userId));
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

      const count = this.getReportCount(listing.id);
      let escalatedNow = false;
      if (count >= REPORT_THRESHOLD) {
        const created = this.db.prepare(`INSERT OR IGNORE INTO moderation_cases
          (session_id,staff_channel_id,escalated_at,status,updated_at) VALUES (?, ?, ?, 'open', ?)`)
          .run(listing.id, staffChannelId, now, now);
        escalatedNow = created.changes === 1;
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
    return this.db.prepare(`INSERT OR IGNORE INTO reporter_blacklist
      (user_id,blacklisted_at,moderator_id,reason) VALUES (?,?,?,?)`)
      .run(userId, now, moderatorId, reason).changes === 1;
  }

  isReporterOnCase(sessionId: string, reporterId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM live_server_reports WHERE session_id=? AND reporter_id=?")
      .get(sessionId, reporterId));
  }

  getHostStrikeCount(hostId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM host_strikes WHERE host_id=? AND active=1")
      .get(hostId) as { count: number };
    return row.count;
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
      if (strikeCount >= 3) {
        this.db.prepare(`INSERT OR IGNORE INTO host_blacklist
          (user_id,blacklisted_at,triggering_session_id,moderator_id) VALUES (?,?,?,?)`)
          .run(listing.owner_id, now, sessionId, moderatorId);
      }
      return {
        ok: true,
        moderationCase: this.getCase(sessionId)!,
        strikeCount,
        hostBlacklisted: this.isHostBlacklisted(listing.owner_id)
      };
    })();
  }
}
