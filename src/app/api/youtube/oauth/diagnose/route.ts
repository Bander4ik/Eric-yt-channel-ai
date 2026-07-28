import { NextResponse } from "next/server";
import { getOAuthTokens, getValidAccessToken } from "@/lib/google-oauth";

export const runtime = "nodejs";

/**
 * Diagnostic helper for "why does this channel still 403 even though I
 * connected an account?". Pulls three independent signals so the user
 * can see exactly what went wrong:
 *
 *   1. tokens.scope — which scopes the saved tokens actually carry
 *      (catches the case where the user unticked monetary on the
 *      Google consent screen).
 *   2. userinfo.email — which Google account actually authorized
 *      (catches the case where Google's account picker silently picked
 *      the wrong account).
 *   3. channels.list?mine=true — which YouTube channels that Google
 *      account actually owns (catches Manager-tier vs Owner; if the
 *      target channel isn't in this list the user is at most a
 *      Manager, not an Owner).
 *
 * No side effects — purely read calls to Google. Safe to spam-run.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId");
  if (!channelId) {
    return NextResponse.json(
      { error: "Pass ?channelId=UCxxx to diagnose a specific channel slot." },
      { status: 400 }
    );
  }

  const tokens = getOAuthTokens(channelId);
  if (!tokens?.refresh_token) {
    return NextResponse.json({
      ok: false,
      stage: "no-tokens",
      message:
        "No OAuth tokens stored for this channel. Click the 'Google' button on the channel row to connect.",
    });
  }

  const grantedScopes = (tokens.scope ?? "").split(" ").filter(Boolean);
  const hasMonetaryScope = grantedScopes.some((s) =>
    s.includes("yt-analytics-monetary")
  );
  const hasAnalyticsScope = grantedScopes.some(
    (s) => s.includes("yt-analytics") || s.includes("yt-analytics-monetary")
  );

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(channelId);
  } catch (err) {
    return NextResponse.json({
      ok: false,
      stage: "refresh-failed",
      message:
        "Refresh-token call to Google failed — most likely the user revoked access in their Google account permissions, or the Cloud app is still on \"Testing\" and the token hit Google's 7-day limit. Publish the app (Audience → Publish app), then reconnect.",
      detail: err instanceof Error ? err.message : String(err),
      grantedScopes,
      hasMonetaryScope,
      hasAnalyticsScope,
    });
  }

  // Who actually authorised? userinfo endpoint returns the email tied
  // to this access_token.
  let email: string | null = null;
  let userinfoError: string | null = null;
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (r.ok) {
      const j = (await r.json()) as { email?: string };
      email = j.email ?? null;
    } else {
      userinfoError = `${r.status} ${r.statusText}`;
    }
  } catch (e) {
    userinfoError = e instanceof Error ? e.message : String(e);
  }

  // Which YouTube channels does this account actually own? `mine=true`
  // returns Owner-tier channels. Manager-tier access on a brand
  // account does NOT show up here — that's exactly the signal we need.
  let ownedChannels: { id: string; title: string }[] = [];
  let channelsError: string | null = null;
  try {
    const r = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      }
    );
    if (r.ok) {
      const j = (await r.json()) as {
        items?: { id: string; snippet?: { title?: string } }[];
      };
      ownedChannels = (j.items ?? []).map((it) => ({
        id: it.id,
        title: it.snippet?.title ?? "(no title)",
      }));
    } else {
      channelsError = `${r.status} ${r.statusText}`;
    }
  } catch (e) {
    channelsError = e instanceof Error ? e.message : String(e);
  }

  const ownsTargetChannel = ownedChannels.some((c) => c.id === channelId);

  // Compose a one-line diagnosis the user can act on.
  let diagnosis: string;
  if (!hasMonetaryScope) {
    diagnosis =
      "The saved tokens DO NOT include the monetary scope. The user probably unticked it on the Google consent screen. Disconnect this channel's Google here and reconnect, leaving every checkbox checked.";
  } else if (!ownsTargetChannel && ownedChannels.length > 0) {
    diagnosis = `The authorised Google account (${email ?? "?"}) does NOT own this channel. It owns: ${ownedChannels
      .map((c) => `${c.title} (${c.id})`)
      .join(
        ", "
      )}. The user picked the wrong account in the Google account picker — disconnect and reconnect, picking the account that actually owns this channel.`;
  } else if (!ownsTargetChannel && ownedChannels.length === 0) {
    diagnosis = `The authorised Google account (${email ?? "?"}) does NOT show any channels via channels.list?mine=true. This usually means the user is only a Manager-tier on a Brand Account that owns the channel — the Primary Owner of that Brand Account has to grant Owner role for monetary analytics to work.`;
  } else {
    diagnosis =
      "Tokens look correct: right scope, right account, owns the target channel. If revenue is still 403, the channel may have a YPP issue (suspended, region-restricted, or freshly-monetised with no data yet). Check YouTube Studio → Earn for this channel.";
  }

  return NextResponse.json({
    ok: true,
    channelId,
    email,
    grantedScopes,
    hasMonetaryScope,
    hasAnalyticsScope,
    ownedChannels,
    ownsTargetChannel,
    userinfoError,
    channelsError,
    diagnosis,
  });
}
