import { NextResponse } from "next/server";
import {
  commentCount,
  createCommentSyncJob,
  getActiveCommentSyncJob,
  getActiveTranscriptionJob,
  getIntegration,
  getSetting,
  getVideosByIds,
  listChannelVideosForCommentSync,
  updateCommentSyncJob,
  upsertComments,
} from "@/lib/db";
import { fetchCommentThreads, YouTubeApiError } from "@/lib/youtube";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Bulk comment-sync for the active channel.
 *
 * Same mental model as /api/deepgram/transcribe-batch:
 *   - GET preview: count + optional filter ("only videos with no
 *     comments yet").
 *   - POST start: background job, UI polls /api/comments/jobs/latest.
 *
 * Selection modes mirror the transcribe picker:
 *   - empty body / "all" → every video on the active channel.
 *   - { onlyMissing: true } → only videos that have NEVER had comments
 *     synced (useful for "fill in the new uploads" after a channel sync).
 *   - { topN, orderBy } → top N by views/recent/oldest.
 *   - { videoIds } → hand-picked list.
 *
 * Quota note: YouTube Data API commentThreads.list costs 1 unit per
 * call, 100 threads per call. With our default maxThreads = 200 per
 * video that's 2 calls per video. A full re-sync of a 500-video
 * channel ≈ 1k units, well under the 10k/day free quota.
 */

type OrderBy = "views" | "recent" | "oldest";

type PostBody = {
  videoIds?: string[];
  topN?: number;
  orderBy?: OrderBy;
  onlyMissing?: boolean;
  /** Per-video cap on comments to pull. Default 200, max 500. */
  maxThreadsPerVideo?: number;
};

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_THREADS = 200;
const HARD_MAX_THREADS = 500;

function parseOrderBy(raw: unknown): OrderBy | undefined {
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
 * Resolve the selection into a concrete list of {id, title}. Same
 * priority ladder as transcribe-batch: explicit IDs > top-N > all.
 */
function resolveBatch(opts: PostBody): Array<{ id: string; title: string }> {
  const onlyMissing = opts.onlyMissing ?? false;

  if (opts.videoIds && opts.videoIds.length > 0) {
    // Channel-scoped lookup so a crafted request can't queue work on a
    // different channel.
    return getVideosByIds(opts.videoIds).map((v) => ({
      id: v.id,
      title: v.title,
    }));
  }

  const list = listChannelVideosForCommentSync({
    onlyMissing,
    orderBy: opts.orderBy,
    limit: opts.topN,
  });
  return list.map((v) => ({ id: v.id, title: v.title }));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;

  // Picker mode — return per-video status for the UI list.
  if (params.get("candidates") === "1") {
    const list = listChannelVideosForCommentSync({
      onlyMissing: params.get("onlyMissing") === "1" ? true : undefined,
      orderBy: parseOrderBy(params.get("orderBy")),
      limit: parsePositiveInt(params.get("limit")) ?? 500,
    });
    return NextResponse.json({
      candidates: list.map((c) => ({
        id: c.id,
        title: c.title,
        views: c.views,
        publishedAt: c.published_at,
        commentsCount: c.comments_count,
        lastSyncedAt: c.last_synced_at,
      })),
    });
  }

  const onlyMissing = params.get("onlyMissing") === "1" ? true : undefined;
  const orderBy = parseOrderBy(params.get("orderBy"));
  const topN = parsePositiveInt(params.get("topN"));
  const videoIdsRaw = params.get("videoIds");
  const videoIds = videoIdsRaw
    ? videoIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const selection = resolveBatch({ onlyMissing, orderBy, topN, videoIds });

  const active = getActiveCommentSyncJob();

  return NextResponse.json({
    total: selection.length,
    videos: selection.slice(0, 5),
    activeJob: active ?? null,
  });
}

export async function POST(req: Request) {
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube API key is not configured. Add it in Settings." },
      { status: 400 }
    );
  }

  // No two concurrent comment-sync jobs.
  const existing = getActiveCommentSyncJob();
  if (existing) {
    return NextResponse.json(
      {
        error: "A comment-sync batch is already running.",
        jobId: existing.id,
      },
      { status: 409 }
    );
  }

  // Refuse to run if a transcription batch is happening — they share
  // the videos table and we don't want the comments INSERTs racing the
  // transcripts UPSERTs that the transcribe batch is doing.
  const activeTranscribe = getActiveTranscriptionJob();
  if (activeTranscribe) {
    return NextResponse.json(
      {
        error:
          "A transcription batch is currently running. Wait for it to finish before syncing comments.",
        jobId: activeTranscribe.id,
      },
      { status: 409 }
    );
  }

  // Refuse during channel sync — channel sync is the canonical "videos
  // table is being mutated right now" signal.
  if (getSetting("sync.inProgress") === "1") {
    return NextResponse.json(
      {
        error:
          "A channel sync is currently running. Wait for it to finish before syncing comments.",
      },
      { status: 409 }
    );
  }

  let body: PostBody = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") body = parsed as PostBody;
    }
  } catch {
    /* empty body is fine */
  }

  const videos = resolveBatch(body);
  if (videos.length === 0) {
    return NextResponse.json(
      {
        error:
          "Nothing to sync. Either the selection is empty or no channel is active.",
      },
      { status: 400 }
    );
  }

  const maxThreads = Math.min(
    HARD_MAX_THREADS,
    Math.max(1, body.maxThreadsPerVideo ?? DEFAULT_MAX_THREADS)
  );

  const jobId = createCommentSyncJob(videos.length);
  log.info("comments-sync", "Bulk comment sync started", {
    jobId,
    videoCount: videos.length,
    maxThreadsPerVideo: maxThreads,
    selectionMode: body.videoIds?.length
      ? "ids"
      : body.topN
        ? `top${body.topN}/${body.orderBy ?? "recent"}`
        : "all",
  });

  void runBatch(jobId, apiKey, videos, maxThreads);

  return NextResponse.json({ ok: true, jobId, total: videos.length });
}

async function runBatch(
  jobId: number,
  apiKey: string,
  videos: Array<{ id: string; title: string }>,
  maxThreads: number
): Promise<void> {
  let cursor = 0;
  let done = 0;
  let failed = 0;
  let commentsAdded = 0;
  let lastError: string | null = null;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= videos.length) return;
      const v = videos[i];
      updateCommentSyncJob(jobId, { current_video_id: v.id });
      try {
        const before = commentCount(v.id).total;
        const threads = await fetchCommentThreads(v.id, apiKey, {
          maxThreads,
          order: "relevance",
        });
        upsertComments(
          threads.map((c) => ({
            id: c.id,
            video_id: v.id,
            parent_id: c.parentId,
            author: c.author,
            author_channel_id: c.authorChannelId,
            text: c.text,
            like_count: c.likes,
            reply_count: c.replyCount,
            published_at: c.publishedAt,
            updated_at: c.updatedAt,
          }))
        );
        const after = commentCount(v.id).total;
        commentsAdded += Math.max(0, after - before);
        done++;
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
        // Don't kill the batch on a single per-video failure — log and
        // keep going. Common cause is "comments are disabled on this
        // video" (YouTubeApiError 403) which is harmless and expected.
        log.warn("comments-sync", `Batch item failed: ${v.id}`, {
          jobId,
          videoId: v.id,
          error: lastError,
          status: err instanceof YouTubeApiError ? err.status : undefined,
        });
      }
      updateCommentSyncJob(jobId, {
        done,
        failed,
        comments_added: commentsAdded,
        last_error: lastError,
      });
    }
  };

  const workers = Array.from({ length: DEFAULT_CONCURRENCY }, () => worker());
  try {
    await Promise.all(workers);
    updateCommentSyncJob(jobId, {
      status: failed === videos.length ? "failed" : "completed",
      completed_at: Math.floor(Date.now() / 1000),
      current_video_id: null,
    });
    log.info("comments-sync", "Bulk comment sync finished", {
      jobId,
      done,
      failed,
      commentsAdded,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateCommentSyncJob(jobId, {
      status: "failed",
      completed_at: Math.floor(Date.now() / 1000),
      last_error: msg,
      current_video_id: null,
    });
    log.error("comments-sync", `Bulk comment sync crashed: ${msg}`, err, {
      jobId,
    });
  }
}
