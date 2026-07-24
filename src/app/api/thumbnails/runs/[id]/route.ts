import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  deleteThumbnailRun,
  getThumbnailRun,
  listThumbnailVariants,
} from "@/lib/db";
import { safeSegment } from "@/lib/thumbnail-style";

/**
 * Delete one generation run, its variant rows (via cascade) and the PNGs
 * it wrote.
 *
 * Without this a channel that generates daily accumulates megabytes of
 * abandoned covers under data/ with no way to clear them from the app —
 * which contradicts the platform's own rule that nothing gets lost:
 * losing things silently is bad, but so is having no way to let go of
 * them deliberately.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const runId = Number(id);
  if (!Number.isFinite(runId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const run = getThumbnailRun(runId);
  if (!run) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  // Take the file paths before the rows go away.
  const files = listThumbnailVariants(runId).flatMap((v) =>
    [v.base_path, v.final_path].filter((p): p is string => !!p)
  );

  deleteThumbnailRun(runId);

  for (const rel of new Set(files)) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, rel));
    } catch {
      /* already gone — the row is what mattered */
    }
  }
  // The run's own folder, once empty. rmdir (not rm -rf) on purpose: if
  // anything unexpected is still in there, leave it alone rather than
  // recursively deleting under a path built from stored data.
  try {
    fs.rmdirSync(
      path.join(DATA_DIR, "thumbnails", safeSegment(run.channel_id), String(runId))
    );
  } catch {
    /* not empty, or never created */
  }

  return NextResponse.json({ ok: true });
}
