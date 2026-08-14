import type { Listing } from "../live-servers/model.js";

export const REPORT_THRESHOLD = 7;

export const REPORT_REASONS = {
  host_not_in_server: "Host is not in the server",
  server_missing: "Server doesn't exist",
  wrong_category: "Incorrect category of grind",
  other: "Other"
} as const;

export type ReportReason = keyof typeof REPORT_REASONS;

export function isReportReason(value: string): value is ReportReason {
  return Object.hasOwn(REPORT_REASONS, value);
}

export function reportReasonLabel(reason: string | null): string {
  return reason && isReportReason(reason) ? REPORT_REASONS[reason] : "Legacy report (reason unavailable)";
}

export type ReportOutcome = "pending" | "valid" | "rejected";
export type CaseStatus = "open" | "ignored" | "struck";

export type ModerationCase = {
  sessionId: string;
  staffChannelId: string;
  staffMessageId: string | null;
  escalatedAt: number;
  status: CaseStatus;
  resolvedBy: string | null;
  resolvedAt: number | null;
  updatedAt: number;
};

export type ReporterSummary = {
  userId: string;
  reportedAt: number;
  total: number;
  valid: number;
  rejected: number;
  reason: ReportReason | null;
  details: string | null;
};

export type ReasonSummary = { reason: ReportReason | null; count: number };

export type CaseSnapshot = {
  case: ModerationCase;
  listing: Listing;
  reportCount: number;
  reasonCounts: ReasonSummary[];
  hostStrikeCount: number;
};

export type StaffActor = {
  userId: string;
  guildId: string | null;
  channelId: string;
  roleIds: readonly string[];
};
