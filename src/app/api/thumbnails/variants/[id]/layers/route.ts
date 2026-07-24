import { NextResponse } from "next/server";
import path from "node:path";
import {
  DATA_DIR,
  getChannelFontPath,
  getThumbnailRun,
  getThumbnailVariant,
} from "@/lib/db";
import {
  coerceZone,
  DEFAULT_OVERLAY,
  renderTextLayer,
  type OverlaySpec,
} from "@/lib/thumbnail-overlay";
import { coerceAspect } from "@/lib/image-provider-types";

/**
 * Layer export: the headline alone, on transparency, at the exact size
 * and position it occupies on the finished cover.
 *
 * The background is already downloadable — it is the `-base.png` the
 * generation wrote — so this route only has to produce the half that
 * exists nowhere on disk. Together they open in Photoshop or Canva as
 * two stacked layers, which is how a channel with a designer finishes a
 * cover without retyping the headline and losing the placement the
 * style profile chose.
 *
 * Rendered on demand rather than written during generation: it is cheap,
 * it calls nothing paid, and it must reflect the CURRENT overlay after
 * any number of free re-renders rather than the first one.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const variantId = Number(id);
  if (!Number.isFinite(variantId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const variant = getThumbnailVariant(variantId);
  if (!variant) {
    return NextResponse.json({ error: "variant not found" }, { status: 404 });
  }

  const stored = parseOverlay(variant.overlay_json);
  if (!stored.text?.trim()) {
    return NextResponse.json(
      {
        error:
          "This variant has no composited headline — the image model drew the text into the picture, so there is no separate layer to export.",
      },
      { status: 400 }
    );
  }

  const run = getThumbnailRun(variant.run_id);
  const spec: OverlaySpec = {
    ...DEFAULT_OVERLAY,
    ...stored,
    text: stored.text,
    zone: coerceZone(stored.zone),
    // The stored spec is the truth; the run's aspect is the fallback for
    // rows written before overlays carried one.
    aspect: coerceAspect(stored.aspect ?? run?.aspect),
  };

  const fontRel = run ? getChannelFontPath(run.channel_id) : null;
  const fontAbs = fontRel ? path.join(DATA_DIR, fontRel) : null;

  try {
    const png = await renderTextLayer(spec, fontAbs);
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(png.byteLength),
        "Content-Disposition": `attachment; filename="variant-${variantId}-text.png"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `could not render the text layer — ${message}` },
      { status: 500 }
    );
  }
}

function parseOverlay(json: string | null): Partial<OverlaySpec> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Partial<OverlaySpec>;
  } catch {
    return {};
  }
}
