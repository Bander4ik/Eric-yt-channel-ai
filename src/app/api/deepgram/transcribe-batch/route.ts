import { NextResponse } from "next/server";
import {
  createTranscriptionJob,
  getActiveChannelId,
  getActiveTranscriptionJob,
  getChannelTranscriptLanguage,
  getIntegration,
  getSetting,
  getVideosByIds,
  listChannelVideosForTranscribe,
  listVideosMissingTranscript,
  recordDeepgramUsage,
  updateTranscriptionJob,
  upsertTranscript,
  type TranscribeCandidate,
} from "@/lib/db";
import { estimateCostCents, transcribeYouTubeVideo } from "@/lib/deepgram";
import {
  fetchSubtitleText,
  SubtitleRateLimitError,
  SUBTITLE_FETCH_DELAY_MS,
} from "@/lib/youtube-subtitles";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Concurrency = 1 — videos are transcribed strictly one after another.
 * Deliberately serial: parallel yt-dlp downloads hammered the machine
 * and tripped YouTube's bot detection faster. One at a time is slower
 * but predictable and easier to reason about.
 */
const CONCURRENCY = 1;

type OrderBy = "views" | "recent" | "oldest";

/**
 * Resolve query/body parameters into a concrete list of videos to
 * transcribe. Shared between GET (preview) and POST (start).
 *
 * Three selection modes (priority order):
 *   1. videoIds — caller picked a specific list. Look them up directly.
 *   2. topN + orderBy — caller wants the top N videos by some sort.
 *   3. Legacy default — "all videos missing a transcript", as before.
 *
 * `onlyMissing` defaults to true for ALL modes — even when the user
 * picks specific IDs we still try to skip ones that already have a
 * usable transcript, unless they explicitly set onlyMissing=false to
 * force a re-transcribe.
 */
function resolveBatchVideos(opts: {
  videoIds?: string[];
  topN?: number;
  orderBy?: OrderBy;
  onlyMissing?: boolean;
}): Array<{ id: string; title: string; duration_seconds: number | null }> {
  const onlyMissing = opts.onlyMissing ?? true;

  // 1. Explicit ID list
  if (opts.videoIds && opts.videoIds.length > 0) {
    const found = getVideosByIds(opts.videoIds);
    if (!onlyMissing) return found;
    // Skip ones that already have a transcript (use the same heuristic
    // as the picker by re-checking against the active-channel candidate
    // list).
    const missing = new Set(
      listChannelVideosForTranscribe({ onlyMissing: true }).map((v) => v.id)
    );
    return found.filter((v) => missing.has(v.id));
  }

  // 2. Top N
  if (opts.topN && opts.topN > 0) {
    const list = listChannelVideosForTranscribe({
      onlyMissing,
      orderBy: opts.orderBy,
      limit: opts.topN,
    });
    return list.map((v) => ({
      id: v.id,
      title: v.title,
      duration_seconds: v.duration_seconds,
    }));
  }

  // 3. Legacy default
  return listVideosMissingTranscript();
}

function parseOrderBy(raw: string | null | undefined): OrderBy | undefined {
  if (raw === "views" || raw === "recent" || raw === "oldest") return raw;
  return undefined;
}

function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * GET — preview the batch the user is about to start.
 *
 * Query params (all optional; falls back to legacy "all missing"):
 *   ?topN=10&orderBy=views      — preview a top-N batch
 *   ?videoIds=abc,def           — preview a hand-picked batch
 *   ?onlyMissing=0              — include already-transcribed videos
 *
 * Returns the same shape it always did, plus a `candidates` field on
 * the new `?candidates=1` query mode — the picker UI calls that to
 * populate the "pick specific videos" list.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  // Picker mode — return the full candidate list for the modal UI.
  if (params.get("candidates") === "1") {
    const candidates = listChannelVideosForTranscribe({
      onlyMissing: params.get("onlyMissing") === "0" ? false : undefined,
      orderBy: parseOrderBy(params.get("orderBy")),
      limit: parsePositiveInt(params.get("limit")) ?? 500,
    });
    return NextResponse.json({
      candidates: candidates.map((c) => ({
        id: c.id,
        title: c.title,
        views: c.views,
        durationSeconds: c.duration_seconds ?? 0,
        publishedAt: c.published_at,
        hasTranscript: c.has_transcript,
        estimatedCostCents: estimateCostCents(c.duration_seconds ?? 0),
      })) satisfies Array<{
        id: string;
        title: string;
        views: number;
        durationSeconds: number;
        publishedAt: number | null;
        hasTranscript: boolean;
        estimatedCostCents: number;
      }>,
    });
  }

  const videoIdsParam = params.get("videoIds");
  const videoIds = videoIdsParam
    ? videoIdsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const selection = resolveBatchVideos({
    videoIds,
    topN: parsePositiveInt(params.get("topN")),
    orderBy: parseOrderBy(params.get("orderBy")),
    onlyMissing: params.get("onlyMissing") === "0" ? false : undefined,
  });

  const totalSeconds = selection.reduce(
    (sum, v) => sum + (v.duration_seconds ?? 0),
    0
  );
  const estimatedCostCents = selection.reduce(
    (sum, v) => sum + estimateCostCents(v.duration_seconds ?? 0),
    0
  );
  const active = getActiveTranscriptionJob();

  return NextResponse.json({
    missing: selection.length,
    totalSeconds,
    estimatedCostCents,
    videos: selection.slice(0, 5).map((v) => ({
      id: v.id,
      title: v.title,
      durationSeconds: v.duration_seconds ?? 0,
    })),
    activeJob: active ?? null,
  });
}

type PostBody = {
  videoIds?: string[];
  topN?: number;
  orderBy?: OrderBy;
  onlyMissing?: boolean;
};

/**
 * POST — kick off the batch. Returns immediately with the jobId; the
 * background async task does the work. UI polls /api/deepgram/jobs/latest
 * for live progress.
 *
 * Body (all optional; empty body = legacy "all missing" behaviour):
 *   {
 *     videoIds?: string[],        // hand-picked list, channel-scoped
 *     topN?: number,              // pick top N by orderBy
 *     orderBy?: "views"|"recent"|"oldest",  // default "recent"
 *     onlyMissing?: boolean       // default true; set false to re-transcribe
 *   }
 */
export async function POST(req: Request) {
  // NOTE: the Deepgram key is deliberately NOT required up front any
  // more. Most videos are transcribed for free from their own YouTube
  // caption track; only videos without captions ever reach Deepgram, and
  // only then — per video, inside the worker loop — do we need a key.
  const apiKey = getIntegration("deepgram")?.api_key ?? null;

  // Don't start a second batch on top of a running one — the UI should
  // prevent this, but be defensive on the server too.
  const existing = getActiveTranscriptionJob();
  if (existing) {
    return NextResponse.json(
      { error: "A transcription batch is already running.", jobId: existing.id },
      { status: 409 }
    );
  }

  // Mutual exclusion with the sync route — a sync could be purging or
  // inserting videos right now, and interleaving batch transcript writes
  // against that is exactly what corrupted the DB last time.
  if (getSetting("sync.inProgress") === "1") {
    return NextResponse.json(
      { error: "A channel sync is currently running. Wait for it to finish before transcribing." },
      { status: 409 }
    );
  }

  // POST body is optional — JSON.parse('') throws, so guard it.
  let body: PostBody = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") body = parsed as PostBody;
    }
  } catch {
    // Malformed body — treat as empty and fall back to legacy behaviour
    // rather than 400'ing. Easier on the user.
  }

  const videos = resolveBatchVideos({
    videoIds: Array.isArray(body.videoIds)
      ? body.videoIds.filter((s): s is string => typeof s === "string")
      : undefined,
    topN: typeof body.topN === "number" ? body.topN : undefined,
    orderBy: parseOrderBy(typeof body.orderBy === "string" ? body.orderBy : null),
    onlyMissing: body.onlyMissing,
  });

  if (videos.length === 0) {
    return NextResponse.json(
      {
        error:
          "Nothing to transcribe. Either the selection is empty, every picked video already has a transcript, or no channel is active.",
      },
      { status: 400 }
    );
  }

  const jobId = createTranscriptionJob(videos.length);
  log.info("deepgram", "Batch transcription job started", {
    jobId,
    videoCount: videos.length,
    selectionMode: body.videoIds?.length
      ? "ids"
      : body.topN
        ? `top${body.topN}/${body.orderBy ?? "recent"}`
        : "all-missing",
  });

  // Fire and forget. `void` tells ESLint and readers "yes, we mean to not
  // await this — the response goes back now, the batch runs in background".
  void runBatch(jobId, apiKey, videos);

  return NextResponse.json({ ok: true, jobId, total: videos.length });
}

/**
 * Serialises calls to `fn` across the ENTIRE job, with a pause of
 * `delayMs` after each call finishes before the next one is allowed to
 * start. Exported (module-private, but structured as a pure factory) so
 * it can be unit-tested in isolation from the route.
 *
 * Why this exists: `CONCURRENCY` workers run in parallel, which is fine
 * for Deepgram (a paid, rate-limit-tolerant API) but is exactly what
 * trips YouTube's caption endpoint — during prototyping, a single
 * video's fourth language request in quick succession came back
 * `HTTP Error 429: Too Many Requests`. Wrapping ONLY the caption call in
 * this gate keeps the Deepgram fallback running at full concurrency
 * while guaranteeing no two caption fetches for this job are ever in
 * flight at once.
 */
export function createSerialGate(delayMs: number) {
  let chain: Promise<unknown> = Promise.resolve();
  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    // Whether fn resolved or rejected, the NEXT scheduled call still has
    // to wait out the pause before it may start — that's what keeps
    // consecutive requests spaced apart even after a caption failure.
    chain = run.then(
      () => new Promise((resolve) => setTimeout(resolve, delayMs)),
      () => new Promise((resolve) => setTimeout(resolve, delayMs))
    );
    return run;
  };
}

async function runBatch(
  jobId: number,
  apiKey: string | null,
  videos: { id: string; title: string; duration_seconds: number | null }[]
): Promise<void> {
  // Queue + worker pattern. `CONCURRENCY` workers pull from a shared
  // cursor, so the Deepgram fallback can run several videos at once.
  // Caption fetches are a different story — see `createSerialGate` above
  // — so they go through a dedicated gate shared by every worker,
  // independent of CONCURRENCY.
  let cursor = 0;
  let done = 0;
  let failed = 0;
  let captionsDone = 0;
  let costCentsTotal = 0;
  let lastError: string | null = null;

  // Once YouTube rate-limits us, every further caption attempt in this
  // job will just fail the same way — stop trying and let everything
  // remaining fall through to Deepgram (or fail per-video if there's no
  // key), rather than hammering YouTube harder for no benefit.
  let captionsDisabled = false;

  const captionGate = createSerialGate(SUBTITLE_FETCH_DELAY_MS);
  // The whole batch is scoped to one active channel (see
  // resolveBatchVideos), so the language hint is the same for every
  // video in it.
  const channelId = getActiveChannelId();

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= videos.length) return;
      const v = videos[i];
      updateTranscriptionJob(jobId, { current_video_id: v.id });

      let transcribed = false;

      // ---- Path 1: YouTube's own subtitle track (free), serialised ----
      if (!captionsDisabled) {
        try {
          const subs = await captionGate(() =>
            fetchSubtitleText(v.id, {
              preferLanguage: getChannelTranscriptLanguage(channelId),
            })
          );
          if (subs) {
            upsertTranscript(v.id, subs.text, subs.language, {
              source: "captions",
              autoGenerated: subs.auto,
            });
            done++;
            captionsDone++;
            transcribed = true;
            log.info("subtitles", "Batch item transcribed from YouTube captions", {
              jobId,
              videoId: v.id,
              language: subs.language,
              auto: subs.auto,
            });
          } else {
            log.info("subtitles", "No usable captions — falling back to Deepgram", {
              jobId,
              videoId: v.id,
            });
          }
        } catch (err) {
          if (err instanceof SubtitleRateLimitError) {
            captionsDisabled = true;
            log.warn(
              "subtitles",
              `YouTube rate-limited captions — disabling captions for the rest of this batch: ${err.message}`,
              { jobId, videoId: v.id }
            );
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(
              "subtitles",
              `Caption fetch failed, falling back to Deepgram: ${msg}`,
              { jobId, videoId: v.id }
            );
          }
        }
      }

      // ---- Path 2: Deepgram (paid), only for videos captions missed ----
      if (!transcribed) {
        if (apiKey) {
          try {
            const result = await transcribeYouTubeVideo(v.id, apiKey);
            upsertTranscript(v.id, result.text, result.language, {
              source: "deepgram",
              autoGenerated: null,
            });
            recordDeepgramUsage({
              videoId: v.id,
              durationSeconds: result.durationSeconds,
              costCents: result.costCents,
              model: result.model,
            });
            done++;
            costCentsTotal += result.costCents;
            transcribed = true;
          } catch (err) {
            failed++;
            lastError = err instanceof Error ? err.message : String(err);
            log.warn("deepgram", `Batch item failed: ${v.id}`, {
              jobId,
              videoId: v.id,
              error: lastError,
            });
          }
        } else {
          failed++;
          lastError = captionsDisabled
            ? `YouTube rate-limited caption fetching for this batch, and "${v.title}" (${v.id}) has no Deepgram API key configured to fall back to. Add a Deepgram key in Settings, or try again later once the rate limit clears.`
            : `"${v.title}" (${v.id}) has no YouTube caption track, and no Deepgram API key is configured to fall back to. Add a Deepgram key in Settings to transcribe it.`;
          log.warn("deepgram", `Batch item failed: ${v.id} (no captions, no Deepgram key)`, {
            jobId,
            videoId: v.id,
          });
        }
      }

      // Flush progress to DB after each item — UI picks it up on next poll.
      updateTranscriptionJob(jobId, {
        done,
        failed,
        captions_done: captionsDone,
        cost_cents: costCentsTotal,
        last_error: lastError,
      });
    }
  };

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  try {
    await Promise.all(workers);
    updateTranscriptionJob(jobId, {
      status: failed === videos.length ? "failed" : "completed",
      completed_at: Math.floor(Date.now() / 1000),
      current_video_id: null,
    });
    log.info("deepgram", "Batch transcription job finished", {
      jobId,
      done,
      failed,
      captionsDone,
      costCents: costCentsTotal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateTranscriptionJob(jobId, {
      status: "failed",
      completed_at: Math.floor(Date.now() / 1000),
      last_error: msg,
      current_video_id: null,
    });
    log.error("deepgram", `Batch transcription job crashed: ${msg}`, err, { jobId });
  }
}

// Re-export the type so the route's TypeScript users see the canonical
// shape (kept here so the import-graph from the picker UI stays clean).
export type { TranscribeCandidate };
