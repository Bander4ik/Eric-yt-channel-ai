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

  // Backgrounds really are written once: a new generation writes a new
  // path, so the browser may hold one forever. The composited `-final`
  // file is NOT — every headline edit and every zone change rewrites it
  // in place, at the same path. Calling that immutable told the browser
  // to keep the old picture for a year, so re-rendering appeared to do
  // nothing at all: the file on disk changed and the screen did not.
  // Found by Vlad changing the zone and watching nothing happen, after
  // my own checks with curl passed — curl has no cache.
  const mutable = /-final\.[a-z0-9]+$/i.test(requested);

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.length),
      "Cache-Control": mutable
        ? "private, no-cache, must-revalidate"
        : "private, max-age=31536000, immutable",
      // Cheap validator so a revalidation costs a 304 rather than a
      // megabyte: the file's size and mtime change together whenever we
      // rewrite it.
      ETag: `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
    },
  });
}
