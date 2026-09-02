import "server-only";
import crypto from "node:crypto";
import { getSetting, setSetting } from "./db";

/**
 * Google OAuth 2.0 — "bring your own client" flow.
 * User creates an OAuth client in their own Google Cloud project,
 * pastes client_id + client_secret here. We handle the auth code <-> tokens
 * dance against their own project. Refresh tokens persist in local SQLite.
 *
 * Redirect URI MUST be: http://localhost:<port>/api/youtube/oauth/callback
 * (3000 unless the client set another port in port.txt — the origin is
 * taken from the request, so it follows whatever port the app runs on)
 * The user must register this exact URI in their GCP OAuth client config.
 */

// Sensitive scopes — Google shows an "app isn't verified" interstitial for
// these unless the app passes public review. Verification is not required for
// personal/known-users installs like this one; publishing the app (one click,
// Audience → Publish app) is what removes the 7-day refresh-token life.
// Note about scopes:
//   - yt-analytics.readonly        — views, watch time, demographics, traffic sources
//   - yt-analytics-monetary.readonly — revenue, RPM, CPM (Owner-only at the
//     channel level; Manager-tier accounts will get 403 even with scope granted)
//   - youtube.readonly             — channel/video metadata
// We request all three — the user grants what they have access to. If
// monetary access is denied (Manager tier), we detect it at runtime and
// hide revenue UI gracefully.
export const SCOPES = [
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export const REDIRECT_PATH = "/api/youtube/oauth/callback";

export type OAuthTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds when access_token expires
  scope: string;
  token_type: string;
};

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
};

// ---------------- Persistence ----------------

export function getOAuthConfig(): OAuthConfig | null {
  const id = getSetting("google.oauth.clientId");
  const secret = getSetting("google.oauth.clientSecret");
  if (!id || !secret) return null;
  return { clientId: id, clientSecret: secret };
}

export function setOAuthConfig(cfg: OAuthConfig): void {
  setSetting("google.oauth.clientId", cfg.clientId.trim());
  setSetting("google.oauth.clientSecret", cfg.clientSecret.trim());
}

export function clearOAuthConfig(): void {
  setSetting("google.oauth.clientId", "");
  setSetting("google.oauth.clientSecret", "");
}

/**
 * Per-channel tokens (multi-account support). Each channel can be tied
 * to a different Google account — useful when the user owns channels
 * across personal + work / brand accounts. Storage layout:
 *
 *   google.oauth.tokens                   — legacy / fallback (no channel scope)
 *   google.oauth.tokens.<channelId>       — per-channel tokens
 *   google.oauth.issuedAt[.<channelId>]   — same shape for issued-at
 *
 * `getOAuthTokens(channelId)` always tries per-channel first, falling
 * back to the global key so deployments configured before the
 * multi-account split keep working unchanged.
 */
function tokensKey(channelId?: string | null): string {
  return channelId ? `google.oauth.tokens.${channelId}` : "google.oauth.tokens";
}

function issuedAtKey(channelId?: string | null): string {
  return channelId
    ? `google.oauth.issuedAt.${channelId}`
    : "google.oauth.issuedAt";
}

/**
 * Sticky "this Cloud project is published" marker — see
 * `markPublishedIfProven`. Sticky because the proof is an event we only
 * observe at refresh time; an idle user must not fall back to warnings.
 */
function publishedKey(channelId?: string | null): string {
  return channelId
    ? `google.oauth.published.${channelId}`
    : "google.oauth.published";
}

/**
 * Google issues 7-day refresh tokens only while the OAuth app's publishing
 * status is "Testing". So a refresh that SUCCEEDS on a token already older
 * than 7 days is proof the app is in production — no guessing, no asking the
 * user what their Cloud console says.
 */
function markPublishedIfProven(channelId?: string | null): void {
  const issued = getSetting(issuedAtKey(channelId));
  if (!issued) return;
  const ageDays = (Date.now() / 1000 - parseInt(issued, 10)) / 86400;
  if (ageDays > 7) setSetting(publishedKey(channelId), "1");
}

export function getOAuthTokens(channelId?: string | null): OAuthTokens | null {
  if (channelId) {
    const direct = getSetting(tokensKey(channelId));
    if (direct) {
      try {
        return JSON.parse(direct) as OAuthTokens;
      } catch {
        // fall through to global
      }
    }
  }
  const raw = getSetting(tokensKey(null));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthTokens;
  } catch {
    return null;
  }
}

export function setOAuthTokens(t: OAuthTokens, channelId?: string | null): void {
  setSetting(tokensKey(channelId), JSON.stringify(t));
}

export function clearOAuthTokens(channelId?: string | null): void {
  setSetting(tokensKey(channelId), "");
}

// ---------------- CSRF state ----------------

export function newState(): string {
  const s = crypto.randomBytes(16).toString("hex");
  setSetting("google.oauth.state", s);
  return s;
}

export function consumeState(received: string | null): boolean {
  const stored = getSetting("google.oauth.state");
  if (!stored || !received || stored !== received) return false;
  setSetting("google.oauth.state", "");
  return true;
}

// ---------------- Flow ----------------

export function buildAuthUrl(origin: string): string {
  const cfg = getOAuthConfig();
  if (!cfg) throw new Error("OAuth client_id/secret not configured");
  const state = newState();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", origin + REDIRECT_PATH);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  // `consent` forces a refresh_token to be issued every time; `select_account`
  // forces Google's account chooser instead of silently using whichever
  // account the browser is signed in to. Both prompts can stack, separated
  // by a space — important for users with multiple Google accounts in
  // their browser (very common: personal + work).
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(
  code: string,
  origin: string,
  channelId?: string | null
): Promise<OAuthTokens> {
  const cfg = getOAuthConfig();
  if (!cfg) throw new Error("OAuth client_id/secret not configured");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: origin + REDIRECT_PATH,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
  if (!data.refresh_token) {
    // This means the user previously consented and Google didn't re-issue a refresh_token.
    // Reuse existing one if we have it; else fail.
    const existing = getOAuthTokens(channelId);
    if (!existing?.refresh_token) {
      throw new Error(
        "Google did not return a refresh_token. Revoke access at https://myaccount.google.com/permissions and try again."
      );
    }
    data.refresh_token = existing.refresh_token;
  }
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + data.expires_in - 60, // 1-min safety
    scope: data.scope,
    token_type: data.token_type,
  };
  setOAuthTokens(tokens, channelId);
  return tokens;
}

export async function refreshAccessToken(channelId?: string | null): Promise<OAuthTokens> {
  const cfg = getOAuthConfig();
  if (!cfg) throw new Error("OAuth not configured");
  const existing = getOAuthTokens(channelId);
  if (!existing?.refresh_token) throw new Error("No refresh_token stored — please reconnect");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: existing.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Refresh failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    refresh_token: existing.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + data.expires_in - 60,
    scope: data.scope ?? existing.scope,
    token_type: data.token_type ?? existing.token_type,
  };
  // Save back to whichever slot we read from. If the caller asked for a
  // specific channel and that channel has its own per-channel tokens,
  // refresh stays per-channel. If we fell back to the global slot,
  // overwrite the global slot.
  const hasPerChannel = !!(channelId && getSetting(tokensKey(channelId)));
  const slot = hasPerChannel ? channelId : null;
  setOAuthTokens(tokens, slot);
  markPublishedIfProven(slot);
  return tokens;
}

/** Returns a valid access_token for the requested channel (or the
 *  global slot when no channelId is passed). Refreshes if expired.
 *  Throws if not connected. */
export async function getValidAccessToken(channelId?: string | null): Promise<string> {
  const t = getOAuthTokens(channelId);
  if (!t?.access_token) throw new Error("Not connected to Google");
  if (Math.floor(Date.now() / 1000) >= t.expires_at) {
    const refreshed = await refreshAccessToken(channelId);
    return refreshed.access_token;
  }
  return t.access_token;
}

export type OAuthStatus = {
  configured: boolean;
  connected: boolean;
  /** True iff the connection is the per-channel slot (vs falling back
   *  to the global / legacy slot). */
  perChannel: boolean;
  expiresAt: number | null;
  refreshTokenAgeDays: number | null;
  /** Observed, not assumed: a refresh succeeded past day 7, which only
   *  happens once the Cloud app is published. Until it flips, the UI must
   *  phrase the 7-day expiry conditionally rather than assert it. */
  publishedProven: boolean;
  scopes: string[];
};

export function getStatus(channelId?: string | null): OAuthStatus {
  const cfg = getOAuthConfig();
  const perChannelTokens = channelId ? getSetting(tokensKey(channelId)) : null;
  const tokens = getOAuthTokens(channelId);
  const slot = perChannelTokens ? channelId : null;
  let ageDays: number | null = null;
  const issued = getSetting(issuedAtKey(slot));
  if (issued) {
    ageDays = Math.floor((Date.now() / 1000 - parseInt(issued, 10)) / 86400);
  }
  return {
    configured: !!cfg,
    connected: !!tokens?.refresh_token,
    perChannel: !!perChannelTokens,
    expiresAt: tokens?.expires_at ?? null,
    refreshTokenAgeDays: ageDays,
    publishedProven: getSetting(publishedKey(slot)) === "1",
    scopes: tokens?.scope ? tokens.scope.split(" ") : [],
  };
}

export function markIssuedNow(channelId?: string | null): void {
  setSetting(issuedAtKey(channelId), String(Math.floor(Date.now() / 1000)));
}

export function revokeLocal(channelId?: string | null): void {
  clearOAuthTokens(channelId);
  if (channelId) {
    setSetting(issuedAtKey(channelId), "");
    setSetting(publishedKey(channelId), "");
  } else {
    setSetting(issuedAtKey(null), "");
    setSetting(publishedKey(null), "");
    setSetting("google.oauth.state", "");
  }
}

// ---------------- Per-channel pending pointer ----------------

/**
 * Single-tenant app: only one OAuth handshake is in flight at a time.
 * We stash the channel id the user clicked "Connect" for so the
 * callback knows which slot to write tokens into. Cleared after
 * successful exchange (or on next start).
 */
const PENDING_CHANNEL_KEY = "google.oauth.pendingChannelId";

export function setPendingChannelId(id: string | null): void {
  setSetting(PENDING_CHANNEL_KEY, id ?? "");
}

export function consumePendingChannelId(): string | null {
  const v = getSetting(PENDING_CHANNEL_KEY);
  setSetting(PENDING_CHANNEL_KEY, "");
  return v && v.trim() ? v : null;
}
