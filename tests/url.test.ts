import { describe, expect, it } from "vitest";
import { normalizePrivateServerUrl } from "../src/live-servers/url.js";

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
