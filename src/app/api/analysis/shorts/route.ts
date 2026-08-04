import { NextResponse } from "next/server";
import {
  DEFAULT_SHORTS_MAX_SECONDS,
  getActiveChannelId,
  getExcludeShortsSetting,
  getShortsMaxSeconds,
  setExcludeShortsSetting,
  setShortsMaxSeconds,
} from "@/lib/db";

/**
 * The channel's "ignore Shorts in analysis" preference.
 *
 * GET returns the current state; POST saves it. Both are plain
 * settings-table reads/writes — nothing here recomputes anything, the
 * analysis functions read the setting on every call (see
 * shortsExclusionSql in db.ts), so the next page load already reflects
 * a change.
 *
 * Scoped to the ACTIVE channel unless `?channelId=` says otherwise,
 * matching the sibling /api/thumbnails/style route.
 */

export const runtime = "nodejs";

function resolveChannelId(req: Request): string | null {
  const url = new URL(req.url);
  return url.searchParams.get("channelId") || getActiveChannelId();
}

function payload(channelId: string) {
  return {
    channelId,
    excludeShorts: getExcludeShortsSetting(channelId),
    maxSeconds: getShortsMaxSeconds(channelId),
    defaultMaxSeconds: DEFAULT_SHORTS_MAX_SECONDS,
  };
}

export async function GET(req: Request) {
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }
  return NextResponse.json(payload(channelId));
}

export async function POST(req: Request) {
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  let body: { excludeShorts?: boolean; maxSeconds?: number } = {};
  try {
    body = (await req.json()) as { excludeShorts?: boolean; maxSeconds?: number };
  } catch {
    body = {};
  }

  if (typeof body.excludeShorts === "boolean") {
    setExcludeShortsSetting(channelId, body.excludeShorts);
  }
  if (Object.prototype.hasOwnProperty.call(body, "maxSeconds")) {
    const n = Number(body.maxSeconds);
    // Reject rather than silently coerce: a rejected save keeps the UI
    // honest about what got stored. (setShortsMaxSeconds would also
    // clamp to the default, but then the user would see 60 appear with
    // no explanation.)
    if (!Number.isInteger(n) || n < 1 || n > 600) {
      return NextResponse.json(
        { error: "Cutoff must be a whole number of seconds between 1 and 600." },
        { status: 400 }
      );
    }
    setShortsMaxSeconds(channelId, n);
  }

  return NextResponse.json(payload(channelId));
}
