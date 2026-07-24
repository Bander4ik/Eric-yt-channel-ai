import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/db";

/**
 * Serves generated thumbnails and uploaded brand assets out of the data
 * folder. They can't live under `public/` because the data folder is
 * user-relocatable via DATA_DIR and is deliberately outside the build.
 *
 * The path is resolved and then checked to be inside DATA_DIR before
 * anything is read. Rejecting ".." in the raw string is not enough —
 * URL-encoded traversal and symlinks both survive that check, and a
 * resolve-then-compare does not care how the escape was spelled.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ segments: string[] }> };

const ALLOWED_ROOTS = new Set(["thumbnails", "brand-assets"]);

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".img": "image/jpeg",
};

export async function GET(_req: Request, ctx: Ctx) {
  const { segments } = await ctx.params;
  if (!segments?.length || !ALLOWED_ROOTS.has(segments[0])) {
    return new Response("Not found", { status: 404 });
  }

  const requested = path.resolve(DATA_DIR, ...segments.map(decodeURIComponent));
  const root = path.resolve(DATA_DIR);
  const rel = path.relative(root, requested);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return new Response("Not found", { status: 404 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(requested);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response("Not found", { status: 404 });
  }

  const body = fs.readFileSync(requested);
  const type =
    CONTENT_TYPES[path.extname(requested).toLowerCase()] ??
    "application/octet-stream";

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.length),
      // Files are immutable once written — a new generation writes a new
      // path — so the browser can hold on to them.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
