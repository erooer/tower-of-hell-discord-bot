import { describe, expect, it, vi } from "vitest";
import {
  RobloxPrivateServerVerifier,
  TOWER_OF_HELL_PLACE_ID,
  type FetchLike
} from "../src/roblox/private-server-verifier.js";

const towerDirect =
  "https://www.roblox.com/games/1962086868/Tower-of-Hell?privateServerLinkCode=AbCdEfGh1234";
const share = "https://www.roblox.com/share?code=AbCdEfGh1234&type=Server";

function queuedFetch(...responses: Response[]): FetchLike {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function html(placeId: string): Response {
  return new Response(
    `<!doctype html><html><head><meta content="${placeId}" name="roblox:start_place_id"></head></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

describe("RobloxPrivateServerVerifier", () => {
  it("accepts a direct Tower of Hell private-server URL", async () => {
    const fetch = vi.fn<FetchLike>();
    const result = await new RobloxPrivateServerVerifier({ fetch }).verify(towerDirect);

    expect(result).toMatchObject({ valid: true, placeId: TOWER_OF_HELL_PLACE_ID, originalUrl: towerDirect });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves an allowlisted Roblox share-link chain to Tower of Hell", async () => {
    const fetch = queuedFetch(
      redirect("https://ro.blox.com/Ebh5?token=safe"),
      redirect("https://www.roblox.com/share-links?code=AbCdEfGh1234&type=Server"),
      html(TOWER_OF_HELL_PLACE_ID)
    );
    const result = await new RobloxPrivateServerVerifier({ fetch }).verify(share);

    expect(result).toMatchObject({
      valid: true,
      placeId: TOWER_OF_HELL_PLACE_ID,
      originalUrl: share,
      resolvedUrl: "https://www.roblox.com/share-links?code=AbCdEfGh1234&type=Server"
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(1, new URL(share), expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects a link resolving to a different Place ID", async () => {
    const result = await new RobloxPrivateServerVerifier({ fetch: queuedFetch(html("1234567890")) }).verify(share);
    expect(result).toMatchObject({ valid: false, reason: "wrong_place", placeId: "1234567890" });
  });

  it.each(["https://example.com/games/1962086868?privateServerLinkCode=AbCdEfGh1234", "not a URL"])(
    "rejects malformed or non-Roblox input: %s",
    async (input) => {
      const fetch = vi.fn<FetchLike>();
      await expect(new RobloxPrivateServerVerifier({ fetch }).verify(input)).resolves.toEqual({
        valid: false,
        reason: "invalid_url"
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("rejects a redirect to a non-Roblox domain without requesting it", async () => {
    const fetch = queuedFetch(redirect("https://evil.example/steal"));
    const result = await new RobloxPrivateServerVerifier({ fetch }).verify(share);

    expect(result).toMatchObject({ valid: false, reason: "unsafe_redirect" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an excessive redirect chain", async () => {
    const fetch = queuedFetch(
      redirect("https://ro.blox.com/first"),
      redirect("https://www.roblox.com/share-links?code=AbCdEfGh1234&type=Server")
    );
    const result = await new RobloxPrivateServerVerifier({ fetch, maxRedirects: 1 }).verify(share);

    expect(result).toMatchObject({ valid: false, reason: "too_many_redirects" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed on network errors", async () => {
    const fetch: FetchLike = vi.fn(async () => { throw new TypeError("network unavailable"); });
    const result = await new RobloxPrivateServerVerifier({ fetch }).verify(share);
    expect(result).toMatchObject({ valid: false, reason: "network_error" });
  });

  it("times out and fails closed", async () => {
    const fetch: FetchLike = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const result = await new RobloxPrivateServerVerifier({ fetch, timeoutMs: 5 }).verify(share);
    expect(result).toMatchObject({ valid: false, reason: "timeout" });
  });

  it("rejects a successful response with no authoritative Place ID", async () => {
    const response = new Response("<title>Tower of Hell</title>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    const result = await new RobloxPrivateServerVerifier({ fetch: queuedFetch(response) }).verify(share);
    expect(result).toMatchObject({ valid: false, reason: "unresolved" });
  });
});
