import { Client, DiscordAPIError, type GuildTextBasedChannel, type Message } from "discord.js";
import type { Config } from "../config.js";
import { KeyedMutex } from "../live-servers/keyed-mutex.js";
import type { LiveServerService } from "../live-servers/service.js";
import { reportersReply, staffCaseMessage, urgentCaseMessage } from "./messages.js";
import type { CaseSnapshot, ReporterSummary, StaffActor } from "./model.js";
import type { ListingRepository } from "../storage/listing-repository.js";
import type { ModerationRepository } from "../storage/moderation-repository.js";
import type { HostModerationStatus } from "../storage/moderation-repository.js";
import { isReportReason } from "./model.js";
import type { HostCooldownStore } from "../storage/host-cooldown-repository.js";
import { hostStatusMessage, type HostStatusAction } from "./host-status.js";
import { NO_SESSION_LOGGER, type LogEvent, type SessionLogger } from "../logging/session-logger.js";

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10008;
}

export type ModerationResult = {
  ok: boolean;
  message: string;
  reporters?: ReporterSummary[];
  reportersPayload?: ReturnType<typeof reportersReply>;
  hostStatusPayload?: ReturnType<typeof hostStatusMessage>;
};

const NO_COOLDOWN_STATUS: HostCooldownStore = {
  get: () => null,
  recordSuccessfulCreation: () => undefined
};

export class ModerationService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly client: Client,
    private readonly listings: ListingRepository,
    private readonly moderation: ModerationRepository,
    private readonly liveServers: LiveServerService,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
    private readonly hostCooldowns: HostCooldownStore = NO_COOLDOWN_STATUS,
    private readonly sessionLogger: SessionLogger = NO_SESSION_LOGGER
  ) {}

  async hostStatus(userId: string, actor: StaffActor): Promise<ModerationResult> {
    const unauthorized = await this.authorizeCurrentModerator(actor);
    if (unauthorized) return unauthorized;
    return {
      ok: true,
      message: "Host moderation status loaded.",
      hostStatusPayload: this.buildHostStatus(userId)
    };
  }

  async updateHostStatus(
    userId: string,
    action: HostStatusAction,
    stateToken: string | null,
    actor: StaffActor
  ): Promise<ModerationResult> {
    const unauthorized = await this.authorizeCurrentModerator(actor);
    if (unauthorized) return unauthorized;
    return this.mutex.run(`host-status:${userId}`, async () => {
      const occurredAt = this.now();
      const beforeStatus = this.moderation.getHostModerationStatus(userId);
      let changed = false;
      let message: string;
      if (action === "strike-add") {
        const expectedCount = Number(stateToken);
        changed = Number.isInteger(expectedCount)
          && this.moderation.addHostStrike(userId, actor.userId, occurredAt, expectedCount);
        message = changed ? "Added one host strike." : "The strike count changed or is already at 3.";
      } else if (action === "strike-remove") {
        changed = Boolean(stateToken && stateToken !== "none")
          && this.moderation.revokeStrike(userId, stateToken!, actor.userId, occurredAt);
        message = changed ? "Removed one active host strike." : "That strike is already inactive or no longer exists.";
      } else if (action === "host-blacklist") {
        changed = this.moderation.addHostBlacklist(userId, actor.userId, occurredAt);
        message = changed ? "Added the host blacklist." : "That user is already host-blacklisted.";
      } else if (action === "host-unblacklist") {
        changed = this.moderation.removeHostBlacklist(userId, actor.userId, occurredAt);
        message = changed ? "Removed the host blacklist." : "That user is not currently host-blacklisted.";
      } else if (action === "reporter-blacklist") {
        changed = this.moderation.addReporterBlacklist(userId, actor.userId, occurredAt);
        message = changed ? "Added the reporter blacklist." : "That user is already reporter-blacklisted.";
      } else if (action === "reporter-unblacklist") {
        changed = this.moderation.removeReporterBlacklist(userId, actor.userId, occurredAt);
        message = changed ? "Removed the reporter blacklist." : "That user is not currently reporter-blacklisted.";
      } else if (action === "cooldown-add") {
        changed = this.moderation.addHostCooldown(userId, actor.userId, occurredAt);
        message = changed ? "Added the normal hosting cooldown." : "That user already has an active hosting cooldown.";
      } else {
        const expectedCreatedAt = Number(stateToken);
        changed = Number.isFinite(expectedCreatedAt)
          && this.moderation.clearHostCooldown(userId, actor.userId, occurredAt, expectedCreatedAt);
        message = changed ? "Cleared the hosting cooldown." : "That user does not have a stored hosting cooldown.";
      }
      const payload = this.buildHostStatus(userId, message);
      if (changed) {
        const status = this.moderation.getHostModerationStatus(userId);
        const cooldown = this.hostCooldowns.get(userId);
        const cooldownActive = Boolean(cooldown && cooldown.nextEligibleAt > occurredAt);
        const dmDelivery = await this.sendModerationDm(
          userId,
          this.hostStatusDmMessages(action, beforeStatus, status)
        );
        await this.safeLog({
          kind: "host-status", title: "Host Status Updated", action: message,
          targetUserId: userId, moderatorId: actor.userId,
          result: `${status.strikeCount} / 3 strikes | Host blacklist: ${status.hostBlacklisted ? "Yes" : "No"} | Reporter blacklist: ${status.reporterBlacklisted ? "Yes" : "No"} | Cooldown: ${cooldownActive ? "Active" : "Not active"}`,
          dmDelivery,
          occurredAt
        });
      }
      return {
        ok: changed,
        message,
        hostStatusPayload: payload
      };
    });
  }

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
    if (inserted) {
      const occurredAt = this.now();
      const dmDelivery = await this.sendModerationDm(reporterId, [
        `You have been reporter blacklisted.\n\nReason: Blacklisted from session ${sessionId}`
      ]);
      await this.safeLog({
        kind: "host-status", title: "Host Status Updated", action: "Added the reporter blacklist.",
        targetUserId: reporterId, moderatorId: actor.userId,
        result: "Reporter blacklist: Yes", dmDelivery, occurredAt
      });
    }
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
      const listing = this.listings.get(sessionId);
      if (action === "strike") await this.liveServers.moderationEnd(sessionId, actor.userId);
      await this.syncCaseMessages(sessionId).catch((error) => console.error("Failed to update resolved moderation case", sessionId, error));
      if (action === "ignore") {
        if (listing) await this.safeLog({
          title: "Reports Ignored", action: "Ignored the session reports", listing,
          actor: { kind: "moderator", userId: actor.userId }, occurredAt: this.now()
        });
        return { ok: true, message: "Reports ignored and recorded as rejected." };
      }
      const strikeDm = [
        `A host strike has been added to your account.\n\nCurrent host strikes: ${result.strikeCount} / 3`
      ];
      if (result.hostBlacklistedNow) strikeDm.push("You have been host blacklisted.");
      const dmDelivery = await this.sendModerationDm(listing!.ownerId, strikeDm);
      await this.safeLog({
        kind: "host-status", title: "Host Status Updated", action: "Added a host strike through Strike / Remove.",
        targetUserId: listing!.ownerId, moderatorId: actor.userId,
        result: `${result.strikeCount} / 3 strikes | Host blacklist: ${result.hostBlacklisted ? "Yes" : "No"}`,
        dmDelivery, occurredAt: this.now()
      });
      if (listing && result.hostBlacklistedNow) {
        await this.safeLog({
          title: "Host Blacklisted", action: "Host blacklist applied after reaching the strike threshold", listing,
          actor: { kind: "moderator", userId: actor.userId }, occurredAt: this.now()
        });
      }
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

  private async authorizeCurrentModerator(actor: StaffActor): Promise<ModerationResult | null> {
    if (actor.guildId !== this.config.guildId || !actor.roleIds.includes(this.config.moderatorRoleId)) {
      return { ok: false, message: "You are not authorized to manage host moderation status." };
    }
    try {
      const guild = await this.client.guilds.fetch(this.config.guildId);
      const member = await guild.members.fetch(actor.userId);
      return member.roles.cache.has(this.config.moderatorRoleId)
        ? null
        : { ok: false, message: "You are not authorized to manage host moderation status." };
    } catch {
      return { ok: false, message: "I couldn't verify your moderator role. Please try again." };
    }
  }

  private buildHostStatus(userId: string, notice?: string): ReturnType<typeof hostStatusMessage> {
    return hostStatusMessage({
      userId,
      moderation: this.moderation.getHostModerationStatus(userId),
      cooldown: this.hostCooldowns.get(userId),
      now: this.now()
    }, notice);
  }

  private hostStatusDmMessages(
    action: HostStatusAction,
    before: HostModerationStatus,
    after: HostModerationStatus
  ): string[] {
    const messages: string[] = [];
    if (action === "strike-add") {
      messages.push(`A host strike has been added to your account.\n\nCurrent host strikes: ${after.strikeCount} / 3`);
    } else if (action === "strike-remove") {
      messages.push(`A host strike has been removed from your account.\n\nCurrent host strikes: ${after.strikeCount} / 3`);
    } else if (action === "host-blacklist") messages.push("You have been host blacklisted.");
    else if (action === "host-unblacklist") messages.push("Your host blacklist has been removed.");
    else if (action === "reporter-blacklist") messages.push("You have been reporter blacklisted.");
    else if (action === "reporter-unblacklist") messages.push("Your reporter blacklist has been removed.");
    else if (action === "cooldown-add") messages.push("A hosting cooldown has been applied to your account.");
    else if (action === "cooldown-clear") messages.push("Your hosting cooldown has been cleared.");

    if (action !== "host-blacklist" && !before.hostBlacklisted && after.hostBlacklisted) {
      messages.push("You have been host blacklisted.");
    }
    if (action !== "host-unblacklist" && before.hostBlacklisted && !after.hostBlacklisted) {
      messages.push("Your host blacklist has been removed.");
    }
    return messages;
  }

  private async sendModerationDm(
    userId: string,
    messages: readonly string[]
  ): Promise<"Delivered" | "Failed"> {
    try {
      await this.client.users.send(userId, { content: messages.join("\n\n") });
      return "Delivered";
    } catch (error) {
      console.error("Moderation notification DM delivery failed", { targetUserId: userId, error });
      return "Failed";
    }
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

  private async safeLog(event: LogEvent): Promise<void> {
    try {
      await this.sessionLogger.log(event);
    } catch (error) {
      console.error("Failed to write moderation session log", event.title,
        event.kind === "host-status" ? event.targetUserId : event.listing.id, error);
    }
  }
}
