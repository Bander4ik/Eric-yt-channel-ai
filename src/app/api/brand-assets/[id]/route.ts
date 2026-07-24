import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, deleteBrandAsset, getBrandAsset } from "@/lib/db";

/** Delete one brand asset, file included. */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const assetId = Number(id);
  if (!Number.isFinite(assetId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const asset = getBrandAsset(assetId);
  if (!asset) {
    return NextResponse.json({ error: "asset not found" }, { status: 404 });
  }

  // Row first, file second. A leftover file is harmless; a row pointing
  // at a deleted file breaks every later generation that reads it.
  deleteBrandAsset(assetId);
  try {
    fs.unlinkSync(path.join(DATA_DIR, asset.file_path));
  } catch {
    /* already gone, or never written — nothing to do */
  }
  return NextResponse.json({ ok: true });
}
