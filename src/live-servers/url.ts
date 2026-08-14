const ALLOWED_HOSTS = new Set(["roblox.com", "www.roblox.com"]);
const PRIVATE_SERVER_CODE = /^[A-Za-z0-9_-]{8,128}$/;

export function normalizePrivateServerUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;

    const path = url.pathname.replace(/\/+$/, "");
    const isShareLink = path === "/share" || path === "/share-links";
    const isGameLink = /^\/games\/\d+(?:\/[^/?#]+)?$/.test(path);
    if (!isShareLink && !isGameLink) return null;

    const code = isShareLink
      ? url.searchParams.get("code")
      : url.searchParams.get("privateServerLinkCode");
    if (!code || !PRIVATE_SERVER_CODE.test(code)) return null;
    if (isShareLink && url.searchParams.get("type") !== "Server") return null;

    // URL.toString() safely canonicalizes the user input while retaining the
    // original Roblox join URL and its parameters for the visible listing.
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function findPrivateServerUrl(input: string): string | null {
  const candidates = input.match(/https:\/\/[^\s<>]+/gi) ?? [];
  for (const candidate of candidates) {
    let trimmed = candidate;
    while (/[\])},.!?:;'\"]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
    const normalized = normalizePrivateServerUrl(trimmed);
    if (normalized) return normalized;
  }
  return null;
}

export function extractPlaceIdFromGameUrl(url: URL): string | null {
  const match = /^\/games\/([0-9]+)(?:\/|$)/.exec(url.pathname);
  return match?.[1] ?? null;
}
