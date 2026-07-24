import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  listThumbnailRuns,
  listThumbnailVariants,
  thumbnailSpendStats,
} from "@/lib/db";

/** Generation history for a channel, newest first, with spend totals. */

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId") || getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));

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
    createdAt: run.created_at,
    images: listThumbnailVariants(run.id),
  }));

  return NextResponse.json({
    channelId,
    runs,
    spend: thumbnailSpendStats(channelId),
  });
}
