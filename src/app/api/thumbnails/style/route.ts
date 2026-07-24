import { NextResponse } from "next/server";
import {
  countVisibleCompetitors,
  getActiveChannelId,
  getThumbnailStyleProfile,
  listCompetitorThumbnailWinners,
  listOwnThumbnailWinners,
  saveThumbnailStyleProfile,
} from "@/lib/db";
import {
  analyseThumbnailStyle,
  resolveAnalysisProvider,
  collectReferenceThumbnails,
  MAX_COMPETITOR_REFS,
  MAX_OWN_REFS,
  MIN_WINNERS,
  PROFILE_MAX_AGE_MS,
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

export async function GET(req: Request) {
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  const row = getThumbnailStyleProfile(channelId);
  const own = listOwnThumbnailWinners(channelId, MAX_OWN_REFS);
  const competitor = listCompetitorThumbnailWinners(channelId, MAX_COMPETITOR_REFS);

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
    // Live counts of what a fresh analysis would look at right now.
    available: {
      own: own.length,
      competitor: competitor.length,
      competitorsTracked: countVisibleCompetitors(channelId),
      minWinners: MIN_WINNERS,
    },
    winners: {
      own: own.map(publicWinner),
      competitor: competitor.map(publicWinner),
    },
    stale: ageMs !== null && ageMs > PROFILE_MAX_AGE_MS,
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
  const channelId = resolveChannelId(req);
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

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
          "No text model is configured. Add a Claude or a Gemini API key in Integrations — Gemini has a free tier.",
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

  const ownCount = listOwnThumbnailWinners(channelId, MAX_OWN_REFS).length;
  const compCount = listCompetitorThumbnailWinners(
    channelId,
    MAX_COMPETITOR_REFS
  ).length;
  if (ownCount + compCount === 0) {
    return NextResponse.json(
      {
        error:
          "No thumbnails to analyse yet. Sync this channel's videos, and add competitors on the Competitors tab.",
      },
      { status: 400 }
    );
  }

  startJob(key, ownCount + compCount, "collecting reference thumbnails");
  log.info("thumbnails", "Style analysis started", {
    channelId,
    own: ownCount,
    competitor: compCount,
  });

  // Fire-and-forget: the analysis finishes on the server whether or not
  // the tab stays open.
  void (async () => {
    try {
      const refs = await collectReferenceThumbnails(channelId, (done, total) => {
        progressJob(key, { done, total, stage: "collecting reference thumbnails" });
      });

      progressJob(key, {
        stage: `analysing ${refs.own.length + refs.competitor.length} thumbnails`,
      });

      // A dry run against a seeded database has no real thumbnails to
      // download, so fall back to the winner ids themselves — the point
      // is to exercise the pipeline, not to pretend images were read.
      const dryWithoutImages =
        isDryRun() && refs.own.length + refs.competitor.length === 0;

      const ownIds = dryWithoutImages
        ? listOwnThumbnailWinners(channelId, MAX_OWN_REFS).map((w) => w.videoId)
        : refs.own.map((r) => r.videoId);
      const competitorIds = dryWithoutImages
        ? listCompetitorThumbnailWinners(channelId, MAX_COMPETITOR_REFS).map(
            (w) => w.videoId
          )
        : refs.competitor.map((r) => r.videoId);

      const { profile, model } = dryWithoutImages
        ? { profile: dryRunProfile({ ownIds, competitorIds }), model: "dry-run" }
        : await analyseThumbnailStyle({
            analyser,
            own: refs.own,
            competitor: refs.competitor,
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
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("thumbnails", `Style analysis failed: ${message}`, err, {
        channelId,
      });
      finishJob(key, { lastError: message, stage: "failed" });
    }
  })();

  return NextResponse.json({ ok: true, started: true, total: ownCount + compCount });
}


