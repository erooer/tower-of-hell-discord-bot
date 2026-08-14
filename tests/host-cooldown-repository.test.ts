import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { HostCooldownRepository, HOST_COOLDOWN_MS } from "../src/storage/host-cooldown-repository.js";
import { ListingRepository } from "../src/storage/listing-repository.js";

function createListing(repository: ListingRepository, createdAt: number) {
  return repository.create({
    guildId: "guild", ownerId: "host", type: "carmine", url: "https://www.roblox.com/share?code=Code123&type=Server",
    liveChannelId: "live", liveMessageId: "live-message", controlChannelId: "commands", controlMessageId: "control-message",
    createdAt, expiresAt: createdAt + 7_200_000
  });
}

describe("HostCooldownRepository", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("persists a successful creation and its two-hour eligibility time across reloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "host-cooldown-"));
    directories.push(directory);
    const path = join(directory, "bot.sqlite");
    const createdAt = 1_800_000_000_000;

    let database = openDatabase(path);
    const listing = createListing(new ListingRepository(database), createdAt);
    new HostCooldownRepository(database).recordSuccessfulCreation("host", listing.id, createdAt);
    database.close();

    database = openDatabase(path);
    expect(new HostCooldownRepository(database).get("host")).toEqual({
      userId: "host", listingId: listing.id, successfulCreationAt: createdAt,
      nextEligibleAt: createdAt + HOST_COOLDOWN_MS
    });
    database.close();
  });
});
