import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  listThumbnailRuns,
  listThumbnailVariants,
  thumbnailSpendStats,
  UNPICKED_KEEP_DAYS,
} from "@/lib/db";
import { pruneUnpickedCovers } from "@/lib/thumbnail-retention";

/** Generation history for a channel, newest first, with spend totals. */

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId") || getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

  // The sweep runs here because this is the request that opens the
  // Thumbnails tab, and on a local app that a person starts and closes
  // there is no other moment that reliably happens. See
  // thumbnail-retention.ts for why there is no scheduler.
  const pruned = pruneUnpickedCovers();

  const runs = listThumbnailRuns(channelId, limit).map((run) => ({
    id: run.id,
    title: run.title,
    prompt: run.prompt,
    provider: run.provider,
    model: run.model,
    sourceKind: run.source_kind,
    sourceId: run.source_id,
    variants: run.variants,
    aspect: run.aspect,
    costCents: run.cost_cents,
    credits: run.credits,
    createdAt: run.created_at,
    images: listThumbnailVariants(run.id),
  }));

  return NextResponse.json({
    channelId,
    runs,
    // Stated so the screen can tell the truth about what happens to
    // covers, including what it just did.
    retention: {
      keepDays: UNPICKED_KEEP_DAYS,
      justCleared: pruned.variants,
      justClearedMb: Math.round((pruned.bytes / 1048576) * 10) / 10,
    },
    spend: thumbnailSpendStats(channelId),
  });
}
