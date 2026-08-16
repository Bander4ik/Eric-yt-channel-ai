import { NextResponse } from "next/server";
import { getActiveChannelId, getReachCoverage, ownWinnerBasis } from "@/lib/db";
import { syncReachReports } from "@/lib/yt-reporting";
import { log } from "@/lib/logger";

/**
 * Thumbnail click-through rate — the "reach" reports.
 *
 * GET reports what we hold: how many days of CTR, for how many videos,
 * and which metric the thumbnail winners are currently ranked on. Free,
 * local, no network.
 *
 * POST catches up: makes sure the standing report job exists at Google
 * and downloads whatever days have accumulated since last time.
 *
 * Why POST is safe to call on every app open: reports live on Google's
 * side for 60 days, so a laptop that was closed for three weeks collects
 * all three weeks in one pass. Nothing here needs the machine to be
 * running when a report is generated.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

function resolveChannelId(req: Request, bodyChannelId?: unknown): string | null {
  if (typeof bodyChannelId === "string" && bodyChannelId) return bodyChannelId;
  const url = new URL(req.url);
  return url.searchParams.get("channelId") || getActiveChannelId();
}

export async function GET(req: Request) {
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  const coverage = getReachCoverage(channelId);
  return NextResponse.json({
    channelId,
    coverage,
    // What listOwnThumbnailWinners would rank on right now. The UI shows
    // this so nobody is told their covers were picked by click-through
    // when they were actually picked by views.
    winnerBasis: ownWinnerBasis(channelId),
  });
}

export async function POST(req: Request) {
  let body: { channelId?: unknown } = {};
  try {
    body = (await req.json()) as { channelId?: unknown };
  } catch {
    body = {};
  }

  // Channel from the body first, query second, active last — same order
  // as the thumbnails style route, and for the same reason: a
  // multi-channel user acting on a channel that is not the active one
  // must not have the work silently applied to the active one.
  const channelId = resolveChannelId(req, body.channelId);
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  try {
    const result = await syncReachReports(channelId);

    if (!result.available) {
      // Not an error — but say WHICH not-available this is. "No Google
      // connection" and "Google refused the request" look identical from
      // the outside and lead to completely different fixes, so the
      // provider's own words are passed through rather than replaced
      // with a friendly guess.
      log.info("analytics", "Reach unavailable", { channelId, reason: result.note });
      return NextResponse.json({
        channelId,
        available: false,
        reason:
          result.note ??
          "Click-through data is not available for this channel yet.",
        hint: "If Google is connected and this still says no, the YouTube Reporting API may need to be enabled for your Google Cloud project — it is separate from the Data and Analytics APIs.",
        coverage: getReachCoverage(channelId),
        winnerBasis: ownWinnerBasis(channelId),
      });
    }

    return NextResponse.json({
      channelId,
      available: true,
      jobId: result.jobId,
      reportsIngested: result.reportsIngested,
      reportsSkipped: result.reportsSkipped,
      rowsIngested: result.rowsIngested,
      note: result.note ?? null,
      coverage: getReachCoverage(channelId),
      winnerBasis: ownWinnerBasis(channelId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("analytics", `Reach sync failed: ${message}`, err, { channelId });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
