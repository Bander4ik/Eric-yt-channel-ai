import { NextResponse } from "next/server";
import {
  countVisibleCompetitors,
  getActiveChannelId,
  getThumbnailStyleProfile,
  getThumbnailStyleWindowSetting,
  ownWinnerBasis,
  saveThumbnailStyleProfile,
  setThumbnailStyleWindowMonths,
} from "@/lib/db";
import { syncReachReports } from "@/lib/yt-reporting";
import {
  analyseThumbnailStyle,
  resolveAnalysisProvider,
  collectReferenceThumbnailsForWindow,
  selectThumbnailWindow,
  DEFAULT_STYLE_WINDOW_MONTHS,
  MIN_WINNERS,
  PROFILE_MAX_AGE_MS,
  STYLE_WINDOW_OPTIONS,
  STYLE_WINDOW_STARVATION_FLOOR,
  type ThumbnailStyleProfile,
} from "@/lib/thumbnail-style";
import {
  finishJob,
  isJobRunning,
  jobKey,
  progressJob,
  readJob,
  startJob,
  THUMBNAIL_STYLE_JOB,
} from "@/lib/settings-job";
import { dryRunProfile, isDryRun } from "@/lib/thumbnail-dryrun";
import { log } from "@/lib/logger";

/**
 * The channel's thumbnail style profile.
 *
 * GET is free and never calls a model: it returns the cached profile (if
 * any), the winner counts the next analysis would use, and the job
 * status. That's what lets the tab render a truthful empty state —
 * "24 winners found, analysis not run yet" — without spending anything.
 *
 * POST starts the analysis as a survivable job. Paid work happens only
 * here, on an explicit user action.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

function resolveChannelId(req: Request): string | null {
  const url = new URL(req.url);
  return url.searchParams.get("channelId") || getActiveChannelId();
}

/**
 * The window to preview/run with: an explicit query override (the tab
 * asking "what would N months look like" before the user commits to it),
 * else the channel's saved preference, else the default. `undefined`
 * from the setting means "nothing saved yet" and is distinct from the
 * saved value being `null` ("all time" was explicitly chosen) — see
 * getThumbnailStyleWindowSetting in db.ts.
 */
function resolveRequestedWindowMonths(
  channelId: string,
  override: string | null
): number | null {
  if (override !== null) {
    if (override === "all") return null;
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const stored = getThumbnailStyleWindowSetting(channelId);
  return stored === undefined ? DEFAULT_STYLE_WINDOW_MONTHS : stored;
}

export async function GET(req: Request) {
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  const url = new URL(req.url);
  const requestedMonths = resolveRequestedWindowMonths(
    channelId,
    url.searchParams.get("windowMonths")
  );

  const row = getThumbnailStyleProfile(channelId);
  const selection = selectThumbnailWindow(channelId, requestedMonths);

  let profile: ThumbnailStyleProfile | null = null;
  if (row) {
    try {
      profile = JSON.parse(row.profile_json) as ThumbnailStyleProfile;
    } catch {
      profile = null;
    }
  }

  const ageMs = row ? Date.now() - row.computed_at * 1000 : null;

  return NextResponse.json({
    channelId,
    profile,
    computedAt: row?.computed_at ?? null,
    lowConfidence: row ? row.low_confidence === 1 : null,
    ownSampleSize: row?.own_sample_size ?? null,
    competitorSampleSize: row?.competitor_sample_size ?? null,
    // Live counts of what a fresh analysis would look at right now, at
    // the requested (or saved/default) window.
    available: {
      own: selection.own.length,
      competitor: selection.competitor.length,
      competitorsTracked: countVisibleCompetitors(channelId),
      minWinners: MIN_WINNERS,
    },
    winners: {
      own: selection.own.map(publicWinner),
      competitor: selection.competitor.map(publicWinner),
    },
    window: {
      // What a run started right now would use, after auto-widening.
      months: selection.windowMonths,
      requestedMonths: selection.requestedWindowMonths,
      widened: selection.widened,
      floor: STYLE_WINDOW_STARVATION_FLOOR,
      options: STYLE_WINDOW_OPTIONS,
      // What the CACHED profile above was actually built from — may
      // differ from the live selection if the dropdown has since changed.
      savedMonths: row?.window_months ?? null,
      savedWidened: row ? row.window_widened === 1 : false,
    },
    stale: ageMs !== null && ageMs > PROFILE_MAX_AGE_MS,
    // Which metric a run started right now would rank the channel's own
    // winners on. Shown in the tab so the panel can say what the pattern
    // was learned from instead of leaving the user to assume.
    winnerBasis: ownWinnerBasis(channelId, selection.windowMonths),
    job: readJob(jobKey(THUMBNAIL_STYLE_JOB, channelId)),
  });
}

function publicWinner(w: {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  multiplier: number;
  views: number;
  sourceLabel: string;
}) {
  return {
    videoId: w.videoId,
    title: w.title,
    thumbnailUrl: w.thumbnailUrl,
    multiplier: Number(w.multiplier.toFixed(2)),
    views: w.views,
    sourceLabel: w.sourceLabel,
  };
}

export async function POST(req: Request) {
  // The window is an explicit body field so a fresh click always says
  // what it means, rather than silently trusting whatever was last
  // saved. Sending it also persists it as the channel's new preference.
  let body: { windowMonths?: number | null; channelId?: unknown } = {};
  try {
    body = (await req.json()) as {
      windowMonths?: number | null;
      channelId?: unknown;
    };
  } catch {
    body = {};
  }

  // The channel comes from the body FIRST. The Thumbnails tab posts the
  // channel the user is looking at, which is not necessarily the active
  // one; reading only the query string meant the button analysed the
  // ACTIVE channel and saved the profile under its id instead — silently,
  // with a success message. On a multi-channel account every channel got
  // the active one's profile. Found and fixed first in the sibling
  // Thumbnail-Radar fork; this is the same fix.
  const bodyChannelId =
    typeof body.channelId === "string" && body.channelId ? body.channelId : null;
  const channelId = bodyChannelId ?? resolveChannelId(req);
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  if (Object.prototype.hasOwnProperty.call(body, "windowMonths")) {
    setThumbnailStyleWindowMonths(channelId, body.windowMonths ?? null);
  }
  const stored = getThumbnailStyleWindowSetting(channelId);
  const requestedMonths = stored === undefined ? DEFAULT_STYLE_WINDOW_MONTHS : stored;

  // Either text model can read thumbnails. Dry run calls neither, so a
  // missing key must not block the plumbing from being exercised.
  const analyser =
    resolveAnalysisProvider() ??
    (isDryRun()
      ? { provider: "claude" as const, apiKey: "dry-run", model: "dry-run" }
      : null);
  if (!analyser) {
    return NextResponse.json(
      {
        error:
          "No text model is configured. Add a Claude or a Gemini API key in Settings — Gemini has a free tier.",
      },
      { status: 400 }
    );
  }

  const key = jobKey(THUMBNAIL_STYLE_JOB, channelId);
  if (isJobRunning(key)) {
    return NextResponse.json(
      { error: "A style analysis is already running for this channel." },
      { status: 409 }
    );
  }

  // Pull in any click-through days that accumulated since last time,
  // BEFORE choosing winners — otherwise a channel that has CTR would be
  // ranked on views for one more run. Best-effort by design: no Google
  // connection, a disabled Reporting API or a network blip must not stop
  // a style analysis that works perfectly well on views.
  try {
    const reach = await syncReachReports(channelId);
    if (!reach.available) {
      log.info("thumbnails", "Click-through unavailable, ranking on views", {
        channelId,
        reason: reach.note,
      });
    }
  } catch (err) {
    log.warn("thumbnails", "Reach sync failed before style analysis", {
      channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const selection = selectThumbnailWindow(channelId, requestedMonths);
  const ownCount = selection.own.length;
  const compCount = selection.competitor.length;
  const total = ownCount + compCount;
  const ownBasis = ownWinnerBasis(channelId, selection.windowMonths);

  // Starvation guard: a handful of images is not a pattern, it's a
  // guess. Widening already happened inside selectThumbnailWindow -- if
  // the pool is still this thin even at "all time", refuse rather than
  // build a profile nobody should trust, and say exactly how many were
  // found so the user knows this is a data problem, not a bug.
  if (total < STYLE_WINDOW_STARVATION_FLOOR) {
    const windowLabel =
      selection.windowMonths === null
        ? "the channel's full history"
        : `the last ${selection.windowMonths} months`;
    return NextResponse.json(
      {
        error:
          total === 0
            ? "No thumbnails to analyse yet. Sync this channel's videos, and add competitors on the Competitors tab."
            : `Only ${total} thumbnail${total === 1 ? "" : "s"} found in ${windowLabel} — too few to learn a reliable style from. Sync more videos, add competitors, or widen the window before running this analysis.`,
      },
      { status: 400 }
    );
  }

  startJob(key, total, "collecting reference thumbnails");
  log.info("thumbnails", "Style analysis started", {
    channelId,
    own: ownCount,
    competitor: compCount,
    windowMonths: selection.windowMonths,
    requestedWindowMonths: selection.requestedWindowMonths,
    widened: selection.widened,
  });

  // Fire-and-forget: the analysis finishes on the server whether or not
  // the tab stays open.
  void (async () => {
    try {
      const refs = await collectReferenceThumbnailsForWindow(
        channelId,
        { own: selection.own, competitor: selection.competitor },
        (done, jobTotal) => {
          progressJob(key, { done, total: jobTotal, stage: "collecting reference thumbnails" });
        }
      );

      progressJob(key, {
        stage: `analysing ${refs.own.length + refs.competitor.length} thumbnails`,
      });

      // A dry run against a seeded database has no real thumbnails to
      // download, so fall back to the winner ids themselves — the point
      // is to exercise the pipeline, not to pretend images were read.
      const dryWithoutImages =
        isDryRun() && refs.own.length + refs.competitor.length === 0;

      const ownIds = dryWithoutImages
        ? selection.own.map((w) => w.videoId)
        : refs.own.map((r) => r.videoId);
      const competitorIds = dryWithoutImages
        ? selection.competitor.map((w) => w.videoId)
        : refs.competitor.map((r) => r.videoId);

      const { profile, model } = dryWithoutImages
        ? { profile: dryRunProfile({ ownIds, competitorIds }), model: "dry-run" }
        : await analyseThumbnailStyle({
            analyser,
            own: refs.own,
            competitor: refs.competitor,
            ownBasis,
          });

      // Confidence is decided by OUR winner count, not by the model's
      // self-assessment — the whole point of the n>=5 bar is that the
      // thing being measured doesn't get to grade itself.
      const lowConfidence = ownIds.length < MIN_WINNERS;

      saveThumbnailStyleProfile({
        channelId,
        profileJson: JSON.stringify(profile),
        ownVideoIds: ownIds,
        competitorVideoIds: competitorIds,
        lowConfidence,
        model,
        windowMonths: selection.windowMonths,
        widened: selection.widened,
      });

      finishJob(key, {
        done: refs.own.length + refs.competitor.length,
        stage: "done",
      });
      log.info("thumbnails", "Style analysis finished", {
        channelId,
        own: ownIds.length,
        competitor: competitorIds.length,
        lowConfidence,
        model,
        windowMonths: selection.windowMonths,
        widened: selection.widened,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("thumbnails", `Style analysis failed: ${message}`, err, {
        channelId,
      });
      finishJob(key, { lastError: message, stage: "failed" });
    }
  })();

  return NextResponse.json({
    ok: true,
    started: true,
    total,
    winnerBasis: ownBasis,
    window: {
      months: selection.windowMonths,
      requestedMonths: selection.requestedWindowMonths,
      widened: selection.widened,
    },
  });
}
