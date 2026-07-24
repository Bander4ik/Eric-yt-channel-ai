import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  getChannelFontPath,
  getThumbnailRun,
  getThumbnailVariant,
  pickThumbnailVariant,
  updateThumbnailVariantOverlay,
} from "@/lib/db";
import {
  coerceZone,
  DEFAULT_OVERLAY,
  fontCovers,
  renderOverlay,
  uncoveredCharacters,
  type OverlaySpec,
} from "@/lib/thumbnail-overlay";
import { coerceAspect } from "@/lib/image-provider-types";

/**
 * Per-variant operations: re-render the overlay, or pick this one.
 *
 * Re-rendering is the cheap correction loop the hybrid text approach
 * buys us — changing the headline, its position or its colours redraws
 * from the stored background and calls no API, so fixing a typo costs
 * nothing. That is the entire reason we composite text ourselves.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type PatchBody = {
  text?: unknown;
  zone?: unknown;
  color?: unknown;
  strokeColor?: unknown;
  stroke?: unknown;
  shadow?: unknown;
  uppercase?: unknown;
  maxHeightRatio?: unknown;
  pick?: unknown;
};

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const variantId = Number(id);
  if (!Number.isFinite(variantId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const variant = getThumbnailVariant(variantId);
  if (!variant) {
    return NextResponse.json({ error: "variant not found" }, { status: 404 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.pick === true) {
    const picked = pickThumbnailVariant(variantId);
    return NextResponse.json({ variant: picked });
  }

  if (!variant.base_path) {
    return NextResponse.json(
      { error: "this variant has no background image to re-render" },
      { status: 400 }
    );
  }

  // The re-render must use the same font AND the same frame the run
  // used, otherwise a channel with its own uploaded font would silently
  // get the bundled one back the moment the user edited a word, and a
  // Shorts cover would be redrawn as a landscape one.
  const run = getThumbnailRun(variant.run_id);
  const fontRel = run ? getChannelFontPath(run.channel_id) : null;
  const fontAbs = fontRel ? path.join(DATA_DIR, fontRel) : null;

  const stored = parseOverlay(variant.overlay_json);
  const spec: OverlaySpec = {
    ...DEFAULT_OVERLAY,
    ...stored,
    aspect: coerceAspect(stored.aspect ?? run?.aspect),
    text: typeof body.text === "string" ? body.text : stored.text ?? "",
    zone: body.zone !== undefined ? coerceZone(body.zone) : stored.zone ?? DEFAULT_OVERLAY.zone,
    color: typeof body.color === "string" ? body.color : stored.color ?? DEFAULT_OVERLAY.color,
    strokeColor:
      typeof body.strokeColor === "string"
        ? body.strokeColor
        : stored.strokeColor ?? DEFAULT_OVERLAY.strokeColor,
    stroke: typeof body.stroke === "boolean" ? body.stroke : stored.stroke ?? true,
    shadow: typeof body.shadow === "boolean" ? body.shadow : stored.shadow ?? true,
    uppercase:
      typeof body.uppercase === "boolean"
        ? body.uppercase
        : stored.uppercase ?? true,
    maxHeightRatio:
      typeof body.maxHeightRatio === "number"
        ? body.maxHeightRatio
        : stored.maxHeightRatio ?? DEFAULT_OVERLAY.maxHeightRatio,
  };

  if (spec.text.trim() && !fontCovers(spec.text, fontAbs)) {
    const missing = uncoveredCharacters(spec.text, fontAbs)
      .slice(0, 8)
      .join(" ");
    return NextResponse.json(
      {
        error: `The headline font has no glyphs for: ${missing}. Upload a font that covers this script as a brand asset, or generate again so the image model draws the headline itself.`,
      },
      { status: 400 }
    );
  }

  try {
    const base = fs.readFileSync(path.join(DATA_DIR, variant.base_path));
    const composited = await renderOverlay(base, spec, fontAbs);
    // The background keeps whatever extension the provider's format
    // called for; the composite is always a PNG we drew ourselves.
    const finalRel =
      variant.final_path && variant.final_path !== variant.base_path
        ? variant.final_path
        : variant.base_path.replace(/-base\.[a-z0-9]+$/i, "-final.png");
    fs.writeFileSync(path.join(DATA_DIR, finalRel), composited);
    updateThumbnailVariantOverlay(variantId, finalRel, JSON.stringify(spec));
    return NextResponse.json({ variant: getThumbnailVariant(variantId) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `could not re-render the overlay — ${message}` },
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
