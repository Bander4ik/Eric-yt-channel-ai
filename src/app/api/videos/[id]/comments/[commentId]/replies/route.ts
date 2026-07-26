import { NextResponse } from "next/server";
import {
  getIntegration,
  getVideo,
  listReplies,
  upsertComments,
} from "@/lib/db";
import { fetchCommentReplies, YouTubeApiError } from "@/lib/youtube";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET — return cached replies for a top-level comment.
 * If the cache looks short vs. what YouTube told us (reply_count on parent),
 * the client should call POST to top up.
 *
 * We deliberately don't 404 when the video isn't in the local DB — returning
 * an empty list lets the UI render gracefully (e.g. just after a channel
 * switch where the video row was purged but the chat still references it).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const { id, commentId } = await params;
  if (!getVideo(id)) {
    return NextResponse.json({ replies: [], warning: "video not in local DB" });
  }
  const replies = listReplies(commentId);
  return NextResponse.json({ replies });
}

/**
 * POST — fetch all replies from YouTube and upsert. Used when the user expands
 * a thread whose inlined replies were truncated at 5 during the main sync.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const { id, commentId } = await params;
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

  try {
    const replies = await fetchCommentReplies(commentId, apiKey, 200);
    upsertComments(
      replies.map((c) => ({
        id: c.id,
        video_id: id,
        parent_id: commentId,
        author: c.author,
        author_channel_id: c.authorChannelId,
        text: c.text,
        like_count: c.likes,
        reply_count: 0,
        published_at: c.publishedAt,
        updated_at: c.updatedAt,
      }))
    );
    return NextResponse.json({ ok: true, synced: replies.length });
  } catch (err) {
    if (err instanceof YouTubeApiError) {
      // YouTube returns 404 when the parent comment has been deleted, the
      // thread is region-restricted, or replies are disabled — none of these
      // are "the route is missing" situations. Translate to a 200 with a
      // clear human-readable message so the UI shows actual context instead
      // of a confusing raw "HTTP 404".
      if (err.status === 404 || err.status === 403) {
        return NextResponse.json(
          {
            ok: false,
            unavailable: true,
            error:
              err.status === 404
                ? "Replies unavailable on YouTube — the parent comment may have been deleted, restricted, or the thread is closed."
                : "YouTube refused this request (403). Replies on this thread may be restricted or your API key lacks permission.",
          },
          { status: 200 }
        );
      }
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 400 && err.status < 600 ? err.status : 500 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
