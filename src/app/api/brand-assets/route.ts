import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  createBrandAsset,
  DATA_DIR,
  getActiveChannelId,
  listBrandAssets,
} from "@/lib/db";
import { safeSegment } from "@/lib/thumbnail-style";

/**
 * Per-channel brand assets: the recurring character, logo or frame a
 * faceless channel is recognised by, plus an optional font file.
 *
 * These are passed to the image model as character references, which is
 * what keeps generated covers looking like THIS channel rather than
 * merely like its genre.
 */

export const runtime = "nodejs";

const KINDS = ["character", "logo", "frame", "font"] as const;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".ttf", ".otf"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId") || getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }
  return NextResponse.json({ channelId, assets: listBrandAssets(channelId) });
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected a multipart form upload" },
      { status: 400 }
    );
  }

  const channelId =
    (form.get("channelId") as string | null) || getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  const kind = String(form.get("kind") ?? "");
  if (!(KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${KINDS.join(", ")}` },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "a file is required" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `file is too large (max ${MAX_BYTES / 1024 / 1024} MB)` },
      { status: 400 }
    );
  }

  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json(
      { error: `unsupported file type: ${ext || "(none)"}` },
      { status: 400 }
    );
  }
  if (kind === "font" && ext !== ".ttf" && ext !== ".otf") {
    return NextResponse.json(
      { error: "a font asset must be a .ttf or .otf file" },
      { status: 400 }
    );
  }

  const dir = path.join(DATA_DIR, "brand-assets", safeSegment(channelId));
  fs.mkdirSync(dir, { recursive: true });

  // The stored name is derived, never taken from the upload — a filename
  // is attacker-controlled input even in a local single-user app.
  const stamp = Date.now();
  const fileName = `${kind}-${stamp}${ext}`;
  const relPath = path.posix.join(
    "brand-assets",
    safeSegment(channelId),
    fileName
  );
  fs.writeFileSync(
    path.join(DATA_DIR, relPath),
    Buffer.from(await file.arrayBuffer())
  );

  const label = (form.get("label") as string | null) || file.name;
  const asset = createBrandAsset({
    channelId,
    kind,
    label,
    filePath: relPath,
  });
  return NextResponse.json({ asset });
}
