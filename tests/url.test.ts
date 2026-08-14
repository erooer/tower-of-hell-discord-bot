import { describe, expect, it } from "vitest";
import { findPrivateServerUrl, normalizePrivateServerUrl } from "../src/live-servers/url.js";

describe("normalizePrivateServerUrl", () => {
  it("accepts Roblox server share links and preserves their parameters", () => {
    expect(normalizePrivateServerUrl("https://www.roblox.com/share?code=AbCdEfGh1234&type=Server&utm_source=x"))
      .toBe("https://www.roblox.com/share?code=AbCdEfGh1234&type=Server&utm_source=x");
  });

  it("accepts legacy privateServerLinkCode game links", () => {
    expect(normalizePrivateServerUrl("https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=AbCdEfGh1234"))
      .toBe("https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=AbCdEfGh1234");
  });

  it.each([
    "http://www.roblox.com/share?code=AbCdEfGh1234&type=Server",
    "https://evil.example/share?code=AbCdEfGh1234&type=Server",
    "https://roblox.com/share?type=Server",
    "https://roblox.com/share?code=AbCdEfGh1234&type=ExperienceInvite",
    "javascript:alert(1)",
    "not a url"
  ])("rejects invalid or unsafe input: %s", (input) => {
    expect(normalizePrivateServerUrl(input)).toBeNull();
  });
});

describe("findPrivateServerUrl", () => {
  it.each([
    "Join https://www.roblox.com/share?code=AbCdEfGh1234&type=Server please",
    "Server: <https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=AbCdEfGh1234>.",
    "https://roblox.com/share-links?code=AbCdEfGh1234&type=Server"
  ])("finds a supported private-server URL inside message text: %s", (input) => {
    expect(findPrivateServerUrl(input)).not.toBeNull();
  });

  it.each([
    "Visit https://www.roblox.com/games/1962086868/Tower-of-Hell",
    "Profile: https://www.roblox.com/users/123/profile",
    "Not Roblox: https://example.com/share?code=AbCdEfGh1234&type=Server",
    "No link here"
  ])("does not classify ordinary text or non-private links: %s", (input) => {
    expect(findPrivateServerUrl(input)).toBeNull();
  });
});
