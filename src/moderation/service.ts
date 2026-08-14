import { Client, DiscordAPIError, type GuildTextBasedChannel, type Message } from "discord.js";
import type { Config } from "../config.js";
import { KeyedMutex } from "../live-servers/keyed-mutex.js";
import type { LiveServerService } from "../live-servers/service.js";
import { reportersReply, staffCaseMessage, urgentCaseMessage } from "./messages.js";
import type { CaseSnapshot, ReporterSummary, StaffActor } from "./model.js";
import type { ListingRepository } from "../storage/listing-repository.js";
import type { ModerationRepository } from "../storage/moderation-repository.js";
import { isReportReason } from "./model.js";

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10008;
}

export type ModerationResult = {
  ok: boolean;
  message: string;
  reporters?: ReporterSummary[];
  reportersPayload?: ReturnType<typeof reportersReply>;
};

export class ModerationService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly client: Client,
    private readonly listings: ListingRepository,
    private readonly moderation: ModerationRepository,
    private readonly liveServers: LiveServerService,
    private readonly config: Config,
    private readonly now: () => number = Date.now
  ) {}

  checkReportEligibility(sessionId: string, reporterId: string, guildId: string | null): ModerationResult {
    if (guildId !== this.config.guildId) return { ok: false, message: "This report is not valid in this server." };
    const listing = this.listings.get(sessionId);
    if (!listing || listing.guildId !== guildId || !listing.active || listing.expiresAt <= this.now()) {
      return { ok: false, message: "This live server is no longer active." };
    }
    if (this.moderation.isReporterBlacklisted(reporterId)) {
      return { ok: false, message: "You've been blacklisted from reporting. Contact a moderator to appeal." };
    }
    if (this.moderation.hasReported(sessionId, reporterId)) {
      return { ok: false, message: "You have already reported this server." };
    }
    return { ok: true, message: "Eligible to report." };
  }

  async report(
    sessionId: string,
    reporterId: string,
    guildId: string | null,
    reasonValue: string,
    detailsValue: string
  ): Promise<ModerationResult> {
    if (!isReportReason(reasonValue)) return { ok: false, message: "Select a valid report reason." };
    const details = detailsValue.trim();
    if (details.length > 300) return { ok: false, message: "Additional details must be 300 characters or fewer." };
    if (reasonValue === "other" && details.length === 0) {
      return { ok: false, message: "Additional details are required when selecting Other." };
    }
    if (guildId !== this.config.guildId) return { ok: false, message: "This report is not valid in this server." };
    return this.mutex.run(`report:${sessionId}`, async () => {
      const listing = this.listings.get(sessionId);
      if (!listing || listing.guildId !== guildId || !listing.active || listing.expiresAt <= this.now()) {
        return { ok: false, message: "This live server is no longer active." };
      }
      const result = this.moderation.submitReport(
        listing,
        reporterId,
        this.config.staffReportsChannelId,
        this.now(),
        reasonValue,
        details || null
      );
      if (!result.ok) {
        return result.reason === "blacklisted"
          ? { ok: false, message: "You've been blacklisted from reporting. Contact a moderator to appeal." }
          : { ok: false, message: "You have already reported this server." };
      }
      await this.liveServers.refreshLiveAnnouncement(sessionId).catch((error) => {
        console.error("Failed to update the public report counter; restart reconciliation will retry", sessionId, error);
      });
      if (result.moderationCase) {
        await this.syncCaseMessages(sessionId).catch((error) => {
          console.error("Failed to publish/update moderation case; restart reconciliation will retry", sessionId, error);
        });
      }
      return { ok: true, message: `Report submitted. This server now has ${result.count} unique report${result.count === 1 ? "" : "s"}.` };
    });
  }

  async viewReporters(sessionId: string, actor: StaffActor): Promise<ModerationResult> {
    const unauthorized = this.authorize(actor);
    if (unauthorized) return unauthorized;
    const moderationCase = this.moderation.getCase(sessionId);
    if (!moderationCase) return { ok: false, message: "That moderation case does not exist." };
    const reporters = this.moderation.getReporterSummaries(sessionId);
    return {
      ok: true,
      message: `Found ${reporters.length} unique reporter${reporters.length === 1 ? "" : "s"}.`,
      reporters,
      reportersPayload: reportersReply(sessionId, reporters)
    };
  }

  async blacklistReporter(sessionId: string, reporterId: string, actor: StaffActor): Promise<ModerationResult> {
    const unauthorized = this.authorize(actor);
    if (unauthorized) return unauthorized;
    if (!this.moderation.getCase(sessionId)) return { ok: false, message: "That moderation case does not exist." };
    if (!this.moderation.isReporterOnCase(sessionId, reporterId)) {
      return { ok: false, message: "That user is not a reporter on this moderation case." };
    }
    const inserted = this.moderation.blacklistReporter(reporterId, actor.userId, `Blacklisted from session ${sessionId}`, this.now());
    return inserted
      ? { ok: true, message: `<@${reporterId}> has been blacklisted from future live-server reports.` }
      : { ok: false, message: "That reporter is already blacklisted." };
  }

  async resolve(sessionId: string, action: "ignore" | "strike", actor: StaffActor): Promise<ModerationResult> {
    const unauthorized = this.authorize(actor);
    if (unauthorized) return unauthorized;
    return this.mutex.run(`resolve:${sessionId}`, async () => {
      const result = this.moderation.resolveCase(sessionId, action, actor.userId, this.now());
      if (!result.ok) {
        return result.reason === "resolved"
          ? { ok: false, message: "This moderation case has already been resolved." }
          : { ok: false, message: "That moderation case does not exist." };
      }
      if (action === "strike") await this.liveServers.moderationEnd(sessionId);
      await this.syncCaseMessages(sessionId).catch((error) => console.error("Failed to update resolved moderation case", sessionId, error));
      if (action === "ignore") return { ok: true, message: "Reports ignored and recorded as rejected." };
      return {
        ok: true,
        message: result.hostBlacklisted
          ? `Server removed and strike recorded. The host now has ${result.strikeCount} strikes and is blacklisted.`
          : `Server removed and strike recorded. The host now has ${result.strikeCount} valid strike${result.strikeCount === 1 ? "" : "s"}.`
      };
    });
  }

  async reconcileCases(): Promise<void> {
    for (const moderationCase of this.moderation.listCases()) {
      try {
        await this.syncCaseMessages(moderationCase.sessionId);
      } catch (error) {
        console.error("Failed to reconcile moderation case", moderationCase.sessionId, error);
      }
    }
  }

  async refreshCase(sessionId: string): Promise<void> {
    if (!this.moderation.getCase(sessionId)) return;
    await this.syncCaseMessages(sessionId).catch((error) => {
      console.error("Failed to refresh moderation case", sessionId, error);
    });
  }

  private authorize(actor: StaffActor): ModerationResult | null {
    const valid = actor.guildId === this.config.guildId
      && actor.channelId === this.config.staffReportsChannelId
      && actor.roleIds.includes(this.config.moderatorRoleId);
    return valid ? null : { ok: false, message: "You are not authorized to use moderation controls." };
  }

  private snapshot(sessionId: string): CaseSnapshot | null {
    const moderationCase = this.moderation.getCase(sessionId);
    const listing = this.listings.get(sessionId);
    if (!moderationCase || !listing) return null;
    return {
      case: moderationCase,
      listing,
      reportCount: this.moderation.getReportCount(sessionId),
      reasonCounts: this.moderation.getReasonCounts(sessionId),
      hostStrikeCount: this.moderation.getHostStrikeCount(listing.ownerId)
    };
  }

  private async textChannel(id: string): Promise<GuildTextBasedChannel> {
    const channel = await this.client.channels.fetch(id);
    if (!channel?.isTextBased() || channel.isDMBased()) throw new Error(`Configured staff channel ${id} is not a guild text channel.`);
    return channel;
  }

  private async syncCaseMessages(sessionId: string): Promise<void> {
    const snapshot = this.snapshot(sessionId);
    if (!snapshot) return;
    const channel = await this.textChannel(snapshot.case.staffChannelId);
    await this.syncNormalPanel(snapshot, channel);
    const refreshed = this.snapshot(sessionId);
    if (refreshed?.case.urgentEscalatedAt) await this.syncUrgentPanel(refreshed, channel);
  }

  private async syncNormalPanel(snapshot: CaseSnapshot, channel: GuildTextBasedChannel): Promise<void> {
    const sessionId = snapshot.case.sessionId;
    const payload = staffCaseMessage(snapshot);
    if (snapshot.case.staffMessageId) {
      try {
        const message = await channel.messages.fetch(snapshot.case.staffMessageId);
        await message.edit(payload);
        return;
      } catch (error) {
        if (!isUnknownMessage(error)) throw error;
        this.moderation.setCaseMessage(sessionId, null, this.now());
      }
    }
    const message: Message = await channel.send(payload);
    this.moderation.setCaseMessage(sessionId, message.id, this.now());
  }

  private async syncUrgentPanel(snapshot: CaseSnapshot, channel: GuildTextBasedChannel): Promise<void> {
    const sessionId = snapshot.case.sessionId;
    if (snapshot.case.urgentMessageId) {
      try {
        const message = await channel.messages.fetch(snapshot.case.urgentMessageId);
        await message.edit(urgentCaseMessage(snapshot, this.config.moderatorRoleId, false));
        return;
      } catch (error) {
        if (!isUnknownMessage(error)) throw error;
        this.moderation.setUrgentMessage(sessionId, null, this.now());
      }
    }

    const pingModerators = this.moderation.claimUrgentPing(sessionId, this.now());
    const current = this.snapshot(sessionId) ?? snapshot;
    const message: Message = await channel.send(urgentCaseMessage(current, this.config.moderatorRoleId, pingModerators));
    this.moderation.setUrgentMessage(sessionId, message.id, this.now());
  }
}
