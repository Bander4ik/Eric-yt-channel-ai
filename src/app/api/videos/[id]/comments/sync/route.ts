import { NextResponse } from "next/server";
import { getIntegration, getVideo, upsertComments, commentCount } from "@/lib/db";
import { fetchCommentThreads, YouTubeApiError } from "@/lib/youtube";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!getVideo(id)) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }

  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube API key is not configured. Add it in Settings." },
      { status: 400 }
    );
  }

  // Optional overrides from body; defaults are conservative re: quota.
  const body = (await req.json().catch(() => ({}))) as {
    maxThreads?: number;
    order?: "relevance" | "time";
  };
  const maxThreads = Math.min(500, Math.max(1, Number(body.maxThreads) || 200));
  const order = body.order === "time" ? "time" : "relevance";

  const startedAt = Date.now();
  try {
    const threads = await fetchCommentThreads(id, apiKey, { maxThreads, order });
    upsertComments(
      threads.map((c) => ({
        id: c.id,
        video_id: id,
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
    const summary = commentCount(id);
    log.info("comments-sync", "Comments synced", {
      videoId: id,
      synced: threads.length,
      topLevel: threads.filter((t) => t.parentId === null).length,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      ok: true,
      synced: threads.length,
      topLevelSynced: threads.filter((t) => t.parentId === null).length,
      summary,
    });
  } catch (err) {
    if (err instanceof YouTubeApiError) {
      log.error("comments-sync", `YouTube API error: ${err.message}`, err, {
        videoId: id,
        status: err.status,
      });
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("comments-sync", `Comment sync failed: ${message}`, err, { videoId: id });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
