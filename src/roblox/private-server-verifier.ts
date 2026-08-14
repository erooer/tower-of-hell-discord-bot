import { extractPlaceIdFromGameUrl, normalizePrivateServerUrl } from "../live-servers/url.js";

export const TOWER_OF_HELL_PLACE_ID = "1962086868";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_HOSTS = new Set(["roblox.com", "www.roblox.com", "ro.blox.com"]);
const FINAL_HOSTS = new Set(["roblox.com", "www.roblox.com"]);

export type RobloxVerificationFailure =
  | "invalid_url"
  | "wrong_place"
  | "unsafe_redirect"
  | "too_many_redirects"
  | "timeout"
  | "network_error"
  | "unresolved";

export type RobloxVerificationResult =
  | {
      valid: true;
      originalUrl: string;
      resolvedUrl: string;
      placeId: typeof TOWER_OF_HELL_PLACE_ID;
    }
  | {
      valid: false;
      reason: RobloxVerificationFailure;
      originalUrl?: string;
      resolvedUrl?: string;
      placeId?: string;
    };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RobloxVerifierOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
};

export interface PrivateServerVerifier {
  verify(url: string): Promise<RobloxVerificationResult>;
}

export class RobloxPrivateServerVerifier implements PrivateServerVerifier {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;

  constructor(options: RobloxVerifierOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  }

  async verify(input: string): Promise<RobloxVerificationResult> {
    const originalUrl = normalizePrivateServerUrl(input);
    if (!originalUrl) return { valid: false, reason: "invalid_url" };

    const original = new URL(originalUrl);
    const directPlaceId = extractPlaceIdFromGameUrl(original);
    if (directPlaceId) return this.placeResult(originalUrl, originalUrl, directPlaceId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();

    try {
      let current = original;
      for (let redirects = 0; ; redirects += 1) {
        if (!this.isAllowedRequestUrl(current)) {
          return { valid: false, reason: "unsafe_redirect", originalUrl, resolvedUrl: current.toString() };
        }

        const response = await this.fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": "TowerOfHellLiveServerBot/1.0"
          }
        });

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get("location");
          if (!location) return { valid: false, reason: "unresolved", originalUrl, resolvedUrl: current.toString() };
          if (redirects >= this.maxRedirects) {
            return { valid: false, reason: "too_many_redirects", originalUrl, resolvedUrl: current.toString() };
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return { valid: false, reason: "unresolved", originalUrl, resolvedUrl: current.toString() };
          }
          if (!this.isAllowedRequestUrl(next)) {
            return { valid: false, reason: "unsafe_redirect", originalUrl, resolvedUrl: next.toString() };
          }
          current = next;
          continue;
        }

        if (!response.ok || !FINAL_HOSTS.has(current.hostname.toLowerCase())) {
          return { valid: false, reason: "unresolved", originalUrl, resolvedUrl: current.toString() };
        }

        const urlPlaceId = extractPlaceIdFromGameUrl(current);
        if (urlPlaceId) return this.placeResult(originalUrl, current.toString(), urlPlaceId);

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("text/html")) {
          return { valid: false, reason: "unresolved", originalUrl, resolvedUrl: current.toString() };
        }
        const html = await this.readLimitedBody(response);
        if (html === null) return { valid: false, reason: "unresolved", originalUrl, resolvedUrl: current.toString() };
        const metaPlaceId = extractStartPlaceIdMeta(html);
        if (!metaPlaceId) return { valid: false, reason: "unresolved", originalUrl, resolvedUrl: current.toString() };
        return this.placeResult(originalUrl, current.toString(), metaPlaceId);
      }
    } catch (error) {
      const timedOut = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      return { valid: false, reason: timedOut ? "timeout" : "network_error", originalUrl };
    } finally {
      clearTimeout(timeout);
    }
  }

  private placeResult(originalUrl: string, resolvedUrl: string, placeId: string): RobloxVerificationResult {
    if (placeId !== TOWER_OF_HELL_PLACE_ID) {
      return { valid: false, reason: "wrong_place", originalUrl, resolvedUrl, placeId };
    }
    return { valid: true, originalUrl, resolvedUrl, placeId: TOWER_OF_HELL_PLACE_ID };
  }

  private isAllowedRequestUrl(url: URL): boolean {
    return url.protocol === "https:" && REDIRECT_HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.password;
  }

  private async readLimitedBody(response: Response): Promise<string | null> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) return null;
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > this.maxResponseBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  }
}

export function extractStartPlaceIdMeta(html: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gi)) {
      attributes.set(attribute[1]!.toLowerCase(), attribute[3]!);
    }
    if (attributes.get("name")?.toLowerCase() === "roblox:start_place_id") {
      const value = attributes.get("content");
      return value && /^[0-9]+$/.test(value) ? value : null;
    }
  }
  return null;
}

export async function verifyTowerOfHellPrivateServer(
  url: string,
  options: RobloxVerifierOptions = {}
): Promise<RobloxVerificationResult> {
  return new RobloxPrivateServerVerifier(options).verify(url);
}
