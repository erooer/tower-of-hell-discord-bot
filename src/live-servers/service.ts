import {
  Client,
  DiscordAPIError,
  type GuildTextBasedChannel,
  type Message,
  type TextBasedChannel
} from "discord.js";
import type { Config } from "../config.js";
import type { ListingRepository } from "../storage/listing-repository.js";
import {
  HOST_MESSAGE_MAX_LENGTH,
  isHostSource,
  LISTING_LIFETIME_MS,
  type HostSource,
  type Listing,
  type ServerType
} from "./model.js";
import { controlMessage, liveMessage } from "./messages.js";
import { KeyedMutex } from "./keyed-mutex.js";
import {
  RobloxPrivateServerVerifier,
  type PrivateServerVerifier,
  type RobloxVerificationResult
} from "../roblox/private-server-verifier.js";
import type { HostCooldownStore } from "../storage/host-cooldown-repository.js";
import { NO_SESSION_LOGGER, type SessionLogEvent, type SessionLogger } from "../logging/session-logger.js";

export type ServiceResult = { ok: true; listing: Listing; message?: string } | { ok: false; message: string };

export interface HostStatusProvider {
  isHostBlacklisted(userId: string): boolean;
  getReportCount?(sessionId: string): number;
}

export type HostingEligibility =
  | { ok: true }
  | { ok: false; message: string; nextEligibleAt?: number };

const NO_HOST_COOLDOWNS: HostCooldownStore = {
  get: () => null,
  recordSuccessfulCreation: () => undefined
};

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10008;
}

export class LiveServerService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly client: Client,
    private readonly repository: ListingRepository,
    private readonly config: Config,
    private readonly now: () => number = Date.now,
    private readonly privateServerVerifier: PrivateServerVerifier = new RobloxPrivateServerVerifier(),
    private readonly hostStatus: HostStatusProvider = { isHostBlacklisted: () => false },
    private readonly hostCooldowns: HostCooldownStore = NO_HOST_COOLDOWNS,
    private readonly sessionLogger: SessionLogger = NO_SESSION_LOGGER
  ) {}

  findActive(guildId: string, ownerId: string, type: ServerType): Listing | null {
    return this.repository.getActiveForOwner(guildId, ownerId, type);
  }

  get(id: string): Listing | null {
    return this.repository.get(id);
  }

  isHostBlacklisted(ownerId: string): boolean {
    return this.hostStatus.isHostBlacklisted(ownerId);
  }

  checkHostingEligibility(ownerId: string, bypassCooldown = false): HostingEligibility {
    if (this.isHostBlacklisted(ownerId)) {
      return {
        ok: false,
        message: "You are blacklisted from creating live-server announcements. Contact a moderator to appeal."
      };
    }
    const cooldown = this.hostCooldowns.get(ownerId);
    if (!bypassCooldown && cooldown && cooldown.nextEligibleAt > this.now()) {
      return {
        ok: false,
        message: `You can host another server <t:${Math.floor(cooldown.nextEligibleAt / 1_000)}:R>.`,
        nextEligibleAt: cooldown.nextEligibleAt
      };
    }
    return { ok: true };
  }

  checkCreationEligibility(guildId: string, ownerId: string, type: ServerType, bypassCooldown = false): HostingEligibility {
    const eligibility = this.checkHostingEligibility(ownerId, bypassCooldown);
    if (!eligibility.ok) return eligibility;
    if (this.findActive(guildId, ownerId, type)) {
      return { ok: false, message: "You already have an active listing of this type. Use its existing control panel." };
    }
    return { ok: true };
  }

  private roleId(type: ServerType): string {
    if (type === "carmine") return this.config.carmineRoleId;
    if (type === "xp") return this.config.xpRoleId;
    return this.config.eventRoleId;
  }

  private reportCount(sessionId: string): number {
    return this.hostStatus.getReportCount?.(sessionId) ?? 0;
  }

  private async textChannel(id: string): Promise<GuildTextBasedChannel> {
    const channel = await this.client.channels.fetch(id);
    if (!channel?.isTextBased() || channel.isDMBased()) throw new Error(`Configured channel ${id} is not a guild text channel.`);
    return channel;
  }

  private async hasModeratorRole(guildId: string, userId: string): Promise<boolean> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      return member.roles.cache.has(this.config.moderatorRoleId);
    } catch {
      // Role lookup fails closed: inability to verify the exact configured role
      // never grants a cooldown bypass.
      return false;
    }
  }

  async create(
    guildId: string,
    ownerId: string,
    type: ServerType,
    url: string,
    hostSource: HostSource = "self",
    hostMessageValue = ""
  ): Promise<ServiceResult> {
    if (!isHostSource(hostSource)) return { ok: false, message: "Choose Self Hosted or Other." };
    const hostMessage = hostMessageValue.trim() || null;
    if (hostMessage && hostMessage.length > HOST_MESSAGE_MAX_LENGTH) {
      return { ok: false, message: `Message from host must be ${HOST_MESSAGE_MAX_LENGTH} characters or fewer.` };
    }
    return this.mutex.run(`owner:${guildId}:${ownerId}`, async () => {
      const isModerator = await this.hasModeratorRole(guildId, ownerId);
      const eligibility = this.checkCreationEligibility(guildId, ownerId, type, isModerator);
      if (!eligibility.ok) return { ok: false, message: eligibility.message };

      const verification = await this.privateServerVerifier.verify(url);
      if (!verification.valid) return { ok: false, message: this.verificationFailureMessage(verification) };

      const createdAt = this.now();
      let listing: Listing;
      try {
        listing = this.repository.create({
          guildId, ownerId, type, hostSource, hostMessage, url: verification.originalUrl,
          liveChannelId: this.config.liveChannelId,
          liveMessageId: null,
          controlChannelId: this.config.commandsChannelId,
          controlMessageId: null,
          createdAt,
          expiresAt: createdAt + LISTING_LIFETIME_MS
        });
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          return { ok: false, message: "You already have an active listing of this type. Use its control panel instead." };
        }
        throw error;
      }

      try {
        const liveChannel = await this.textChannel(this.config.liveChannelId);
        const postedLive = await liveChannel.send(liveMessage(listing, this.roleId(type), this.reportCount(listing.id)));
        this.repository.setMessageIds(listing.id, postedLive.id, null, this.now());
        listing = this.repository.get(listing.id)!;

        const controlChannel = await this.textChannel(this.config.commandsChannelId);
        const postedControl = await controlChannel.send(controlMessage(listing));
        this.repository.setControlMessageId(listing.id, postedControl.id, this.now());
        listing = this.repository.get(listing.id)!;
        this.hostCooldowns.recordSuccessfulCreation(ownerId, listing.id, this.now());
        await this.safeLog({
          title: "Session Created", action: "Created a live-server session", listing,
          actor: { kind: "host", userId: ownerId }, occurredAt: this.now()
        });
        return { ok: true, listing, message: `Your listing is live. Manage it with the control panel below.` };
      } catch (error) {
        this.repository.deactivate(listing.id, "creation_failed", this.now());
        await this.cleanup(listing.id);
        console.error("Failed to create listing", listing.id, error);
        return { ok: false, message: "I could not publish the listing. Please check my channel and role permissions, then try again." };
      }
    });
  }

  async changeUrl(id: string, ownerId: string, url: string): Promise<ServiceResult> {
    return this.mutex.run(id, async () => {
      let listing = this.repository.get(id);
      const invalid = this.validateOwnerAndActive(listing, ownerId);
      if (invalid) return invalid;

      const verification = await this.privateServerVerifier.verify(url);
      if (!verification.valid) return { ok: false, message: this.verificationFailureMessage(verification) };

      // The server may have expired while Roblox verification was in flight.
      listing = this.repository.get(id);
      const invalidAfterVerification = this.validateOwnerAndActive(listing, ownerId);
      if (invalidAfterVerification) return invalidAfterVerification;
      listing = this.repository.updateUrl(id, verification.originalUrl, this.now())!;
      try {
        await this.editLive(listing);
        await this.safeLog({
          title: "Server Link Changed", action: "Changed the private-server link", listing,
          actor: { kind: "host", userId: ownerId }, occurredAt: this.now()
        });
        return { ok: true, listing, message: "The server link was updated. The expiration time did not change." };
      } catch (error) {
        console.error("Failed to edit live listing", id, error);
        await this.failListing(id, "live_message_edit_failed");
        return { ok: false, message: "The live message could not be updated, so the listing was ended safely. Please create a new one." };
      }
    });
  }

  async extend(id: string, ownerId: string): Promise<ServiceResult> {
    return this.mutex.run(id, async () => {
      const current = this.repository.get(id);
      const invalid = this.validateOwnerAndActive(current, ownerId);
      if (invalid) return invalid;
      const result = this.repository.extend(id, this.now());
      if (!result.ok) {
        if (result.reason === "too_early") return { ok: false, message: "You can extend this server once there are 30 minutes or less remaining." };
        if (result.reason === "expired") await this.expire(id);
        return { ok: false, message: "This listing is no longer active." };
      }
      try {
        await Promise.all([this.editLive(result.listing), this.editControl(result.listing)]);
        await this.safeLog({
          title: "Session Extended", action: "Extended session by +1 hour", listing: result.listing,
          actor: { kind: "host", userId: ownerId }, occurredAt: this.now()
        });
        return { ok: true, listing: result.listing, message: "Extended by exactly 1 hour from the previous expiration time." };
      } catch (error) {
        console.error("Failed to reflect extension", id, error);
        await this.failListing(id, "message_edit_failed");
        return { ok: false, message: "Discord could not update the listing, so it was ended safely. Please create a new one." };
      }
    });
  }

  async end(id: string, ownerId: string): Promise<ServiceResult> {
    return this.mutex.run(id, async () => {
      const listing = this.repository.get(id);
      if (!listing) return { ok: false, message: "That listing no longer exists." };
      if (!listing.active || listing.expiresAt <= this.now()) {
        return { ok: false, message: "This listing is no longer active." };
      }
      const endedByHost = listing.ownerId === ownerId;
      const endedByModerator = !endedByHost && await this.hasModeratorRole(listing.guildId, ownerId);
      if (!endedByHost && !endedByModerator) {
        return { ok: false, message: "Only the session host or a moderator can end this session." };
      }
      const ended = this.repository.deactivate(id, endedByHost ? "owner_ended" : "moderator_ended", this.now())!;
      await this.cleanup(id);
      await this.safeLog({
        title: "Session Ended", action: "Session manually ended", listing: ended,
        actor: { kind: endedByHost ? "host" : "moderator", userId: ownerId }, occurredAt: this.now()
      });
      return { ok: true, listing: ended, message: "Your server listing has ended." };
    });
  }

  async moderationEnd(id: string, moderatorId?: string): Promise<Listing | null> {
    return this.mutex.run(id, async () => {
      const listing = this.repository.get(id);
      if (!listing || !listing.active) return listing;
      const ended = this.repository.deactivate(id, "moderation_strike", this.now());
      await this.cleanup(id);
      if (ended && moderatorId) {
        await this.safeLog({
          title: "Session Removed", action: "Removed through moderation action (Strike / Remove)", listing: ended,
          actor: { kind: "moderator", userId: moderatorId }, occurredAt: this.now()
        });
      }
      return ended;
    });
  }

  async expire(id: string, writeLog = true): Promise<void> {
    await this.mutex.run(id, async () => {
      const claimed = this.repository.claimIfExpired(id, this.now());
      if (claimed) {
        await this.cleanup(id);
        if (writeLog) {
          await this.safeLog({
            title: "Session Ended", action: "Session expired", listing: claimed,
            actor: { kind: "automatic" }, occurredAt: this.now()
          });
        }
      }
    });
  }

  async expireDue(): Promise<void> {
    const now = this.now();
    for (const listing of this.repository.listActive()) {
      if (listing.expiresAt <= now) await this.expire(listing.id);
    }
    for (const listing of this.repository.listCleanupPending()) await this.cleanup(listing.id);
  }

  async reconcileActive(): Promise<void> {
    for (const listing of this.repository.listActive()) {
      if (listing.expiresAt <= this.now()) {
        await this.expire(listing.id, false);
        continue;
      }
      if (!listing.liveMessageId) {
        await this.failListing(listing.id, "missing_live_message");
        continue;
      }
      try {
        const channel = await this.textChannel(listing.liveChannelId);
        const message = await channel.messages.fetch(listing.liveMessageId);
        // Reapply the canonical payload after a restart. This repairs partial or
        // pre-upgrade messages and guarantees the Join Server button is present.
        await message.edit(liveMessage(listing, this.roleId(listing.type), this.reportCount(listing.id)));
      } catch (error) {
        if (isUnknownMessage(error)) await this.failListing(listing.id, "live_message_deleted");
        else console.error("Could not reconcile listing", listing.id, error);
      }
    }
    await this.expireDue();
  }

  async handleDeletedMessage(messageId: string): Promise<void> {
    const listing = this.repository.getActiveByLiveMessage(messageId);
    if (listing) {
      await this.failListing(listing.id, "live_message_deleted");
      const ended = this.repository.get(listing.id) ?? listing;
      await this.safeLog({
        title: "Session Ended", action: "Public listing manually deleted", listing: ended,
        actor: { kind: "automatic", label: "Manual message deletion (actor unknown)" },
        occurredAt: this.now()
      });
    }
  }

  async refreshLiveAnnouncement(id: string): Promise<void> {
    await this.mutex.run(id, async () => {
      const listing = this.repository.get(id);
      if (!listing || !listing.active || listing.expiresAt <= this.now()) return;
      await this.editLive(listing);
    });
  }

  private validateOwnerAndActive(listing: Listing | null, ownerId: string): { ok: false; message: string } | null {
    if (!listing) return { ok: false, message: "That listing no longer exists." };
    if (listing.ownerId !== ownerId) return { ok: false, message: "Only the person who created this listing can use its controls." };
    if (!listing.active || listing.expiresAt <= this.now()) return { ok: false, message: "This listing is no longer active." };
    return null;
  }

  private verificationFailureMessage(result: Extract<RobloxVerificationResult, { valid: false }>): string {
    if (result.reason === "invalid_url") {
      return "That is not a valid Roblox private-server link.";
    }
    if (result.reason === "wrong_place") {
      return "This private server is not for Tower of Hell.";
    }
    return "I couldn't verify this private server. Please try again.";
  }

  private async failListing(id: string, reason: string): Promise<void> {
    this.repository.deactivate(id, reason, this.now());
    await this.cleanup(id);
  }

  private async safeLog(event: SessionLogEvent): Promise<void> {
    try {
      await this.sessionLogger.log(event);
    } catch (error) {
      console.error("Failed to write session log", event.title, event.listing.id, error);
    }
  }

  private async fetchMessage(channelId: string, messageId: string): Promise<Message> {
    const channel = await this.textChannel(channelId);
    return channel.messages.fetch(messageId);
  }

  private async editLive(listing: Listing): Promise<void> {
    if (!listing.liveMessageId) throw new Error("Listing has no live message ID.");
    const message = await this.fetchMessage(listing.liveChannelId, listing.liveMessageId);
    await message.edit(liveMessage(listing, this.roleId(listing.type), this.reportCount(listing.id)));
  }

  private async editControl(listing: Listing): Promise<void> {
    if (!listing.controlMessageId) return;
    const message = await this.fetchMessage(listing.controlChannelId, listing.controlMessageId);
    await message.edit(controlMessage(listing));
  }

  private async cleanup(id: string): Promise<void> {
    const listing = this.repository.get(id);
    if (!listing) return;
    let liveDone = !listing.liveMessageId;
    let controlDone = !listing.controlMessageId;
    if (listing.liveMessageId) {
      try {
        const message = await this.fetchMessage(listing.liveChannelId, listing.liveMessageId);
        await message.delete();
        liveDone = true;
      } catch (error) {
        if (isUnknownMessage(error)) liveDone = true;
        else console.error("Failed to delete live message; will retry", listing.id, error);
      }
    }
    if (listing.controlMessageId) {
      try {
        const message = await this.fetchMessage(listing.controlChannelId, listing.controlMessageId);
        await message.edit(controlMessage(listing, true));
        controlDone = true;
      } catch (error) {
        if (isUnknownMessage(error)) controlDone = true;
        else console.error("Failed to disable control panel; will retry", listing.id, error);
      }
    }
    if (liveDone && controlDone) this.repository.finishCleanup(id, this.now());
  }
}
