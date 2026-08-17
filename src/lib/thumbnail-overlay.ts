import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { coerceAspect, frameSize } from "./image-provider-types";
import type {
  OverlaySpec,
  TextZone,
} from "./thumbnail-overlay-types";

// Re-exported so server callers can keep importing everything overlay
// related from one place; the definitions live in the client-safe
// module because the Thumbnails tab needs them too.
export {
  DEFAULT_OVERLAY,
  TEXT_ZONES,
  coerceZone,
} from "./thumbnail-overlay-types";
export type { OverlaySpec, TextZone } from "./thumbnail-overlay-types";

/**
 * Text compositing for generated thumbnails.
 *
 * The image model paints the background; the headline is drawn here.
 * That split exists because overlay text is the single highest-leverage
 * element on a thumbnail and it needs to be (a) spelled correctly, which
 * image models still can't guarantee, and (b) editable for free — a
 * typo or a re-word must not cost another paid generation.
 *
 * The font ships with the repo and is registered by path, so what the
 * user sees is what we chose, not whatever happened to be installed on
 * their laptop. Fira Sans ExtraBold covers Latin, Cyrillic and Greek.
 * Anything outside that (CJK, Arabic, Devanagari…) is detected BEFORE
 * rendering by reading the font's own cmap table — see `fontCovers`.
 * A silent fallback would produce boxes or a wrong-weight system font
 * and the user would only find out after uploading.
 *
 * A channel can upload its own .ttf/.otf as a brand asset, which both
 * makes covers look like that channel and is the escape hatch for
 * scripts the bundled font doesn't carry. Every function here takes an
 * optional font path for exactly that; passing none uses the bundled
 * one.
 */

const FONT_FILE = "FiraSans-ExtraBold.ttf";
const BUNDLED_FAMILY = "ChannelThumb";

function bundledFontPath(): string {
  return path.join(process.cwd(), "public", "fonts", FONT_FILE);
}

/**
 * Registered families, keyed by absolute font path. @napi-rs/canvas
 * registers into a process-global table, so re-registering the same file
 * on every request would be pure waste; a custom font also needs a
 * family name that can't collide with the bundled one or with another
 * channel's upload.
 */
const registeredFamilies = new Map<string, string | null>();

function familyNameFor(absPath: string): string {
  if (absPath === bundledFontPath()) return BUNDLED_FAMILY;
  // Derived from the path so two channels' fonts never share a name,
  // and stable so repeat calls hit the cache.
  const slug = absPath.replace(/[^A-Za-z0-9]/g, "").slice(-24);
  return `ChannelThumb_${slug}`;
}

/**
 * Registers a font and returns the family name to use in `ctx.font`, or
 * null when the file could not be loaded.
 */
function registerFont(absPath: string): string | null {
  const cached = registeredFamilies.get(absPath);
  if (cached !== undefined) return cached;

  const family = familyNameFor(absPath);
  let result: string | null = null;
  try {
    GlobalFonts.registerFromPath(absPath, family);
    result = GlobalFonts.families.some((f) => f.family === family)
      ? family
      : null;
  } catch {
    result = null;
  }
  registeredFamilies.set(absPath, result);
  return result;
}

/** Resolves the font to use: the channel's upload, else the bundled one. */
function resolveFontPath(customFontPath?: string | null): string {
  return customFontPath && fs.existsSync(customFontPath)
    ? customFontPath
    : bundledFontPath();
}

/** True when the chosen font could be loaded and used for rendering. */
export function ensureFontRegistered(customFontPath?: string | null): boolean {
  return registerFont(resolveFontPath(customFontPath)) !== null;
}

/* ------------------------------------------------------------------ *
 * Glyph coverage
 *
 * Parsed straight out of the TTF's cmap table rather than inferred from
 * measureText, because a missing glyph still measures to a non-zero
 * width once the renderer falls back to a system font — the exact
 * failure mode we're trying to catch.
 * ------------------------------------------------------------------ */

const coverageCache = new Map<string, Set<number>>();

function readFontCoverage(absPath: string): Set<number> {
  const cached = coverageCache.get(absPath);
  if (cached) return cached;
  const codepoints = new Set<number>();
  try {
    const buf = fs.readFileSync(absPath);
    const numTables = buf.readUInt16BE(4);
    let cmapOffset = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (buf.toString("ascii", rec, rec + 4) === "cmap") {
        cmapOffset = buf.readUInt32BE(rec + 8);
        break;
      }
    }
    if (!cmapOffset) {
      coverageCache.set(absPath, codepoints);
      return codepoints;
    }

    const subtableCount = buf.readUInt16BE(cmapOffset + 2);
    for (let i = 0; i < subtableCount; i++) {
      const enc = cmapOffset + 4 + i * 8;
      const subtable = cmapOffset + buf.readUInt32BE(enc + 4);
      const format = buf.readUInt16BE(subtable);

      if (format === 4) {
        const segCountX2 = buf.readUInt16BE(subtable + 6);
        const segCount = segCountX2 / 2;
        const endBase = subtable + 14;
        const startBase = endBase + segCountX2 + 2;
        for (let s = 0; s < segCount; s++) {
          const end = buf.readUInt16BE(endBase + s * 2);
          const start = buf.readUInt16BE(startBase + s * 2);
          if (start === 0xffff) continue;
          for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
            codepoints.add(cp);
          }
        }
      } else if (format === 12) {
        const nGroups = buf.readUInt32BE(subtable + 12);
        for (let g = 0; g < nGroups; g++) {
          const rec = subtable + 16 + g * 12;
          const start = buf.readUInt32BE(rec);
          const end = buf.readUInt32BE(rec + 4);
          // Guard against a pathological range blowing up memory; real
          // fonts never have one this wide, a corrupt file might.
          if (end - start > 0x10000) continue;
          for (let cp = start; cp <= end; cp++) codepoints.add(cp);
        }
      }
    }
  } catch {
    /* unreadable font — treated as covering nothing, see fontCovers */
  }
  coverageCache.set(absPath, codepoints);
  return codepoints;
}

/**
 * True when every printable character in `text` has a glyph in the font
 * that will actually be used (the channel's uploaded one if it has one,
 * otherwise the bundled one). Whitespace is ignored. Returns false for
 * an unreadable font file, which correctly pushes the caller onto the
 * model-rendered text path instead of producing a page of tofu.
 */
export function fontCovers(text: string, customFontPath?: string | null): boolean {
  const coverage = readFontCoverage(resolveFontPath(customFontPath));
  if (coverage.size === 0) return false;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;
    if (cp === 0x20 || cp === 0x0a || cp === 0x09) continue;
    if (!coverage.has(cp)) return false;
  }
  return true;
}

/** The characters that have no glyph — for an honest error message. */
export function uncoveredCharacters(
  text: string,
  customFontPath?: string | null
): string[] {
  const coverage = readFontCoverage(resolveFontPath(customFontPath));
  if (coverage.size === 0) return [...new Set(text.replace(/\s/g, ""))];
  const missing = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp == null || cp === 0x20 || cp === 0x0a || cp === 0x09) continue;
    if (!coverage.has(cp)) missing.add(ch);
  }
  return [...missing];
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Margins and the font-size ceiling are fractions of the frame, not
 * pixels, so a 1080x1920 Shorts cover gets the same visual proportions
 * as a 1280x720 one instead of a hairline margin and undersized type.
 */
const MARGIN_RATIO = 56 / 1280;
const MAX_FONT_RATIO = 220 / 720;
const MIN_FONT_RATIO = 24 / 720;
const LINE_SPACING = 1.06;
/**
 * How much of the frame a side-anchored headline may occupy.
 *
 * 0.55 rather than a clean half: the subject in these covers sits on
 * roughly the right 45%, and a hard 0.5 made three-word headlines shrink
 * further than the channel's own covers do. Measured against this
 * channel's winners, where the type block ends just before the face
 * begins.
 */
const SIDE_ZONE_WIDTH_RATIO = 0.55;

/**
 * PNG chunks the decoder must see, and nothing else.
 *
 * Every image GPT Image returns — straight from OpenAI or through
 * kie.ai — carries a `caBX` chunk: the C2PA "content credentials"
 * manifest that says an AI made this picture. It is ~25 KB of metadata
 * sitting between IHDR and the pixels, and `@napi-rs/canvas` refuses the
 * whole file when it meets one from a buffer, reporting it as
 * `Invalid SVG image` — the message it falls back to when nothing it
 * knows can decode the bytes.
 *
 * The result was a cover generated, paid for, and then shipped WITHOUT
 * its headline, which is the one thing that makes it look like the
 * channel. Measured, not guessed: the same file loads fine once the
 * ancillary chunks are gone and fails again the moment `caBX` is put
 * back.
 *
 * So the pixels are re-wrapped with only the four critical chunks
 * before decoding. Nothing about the image changes — colour profiles
 * and text metadata are irrelevant to compositing — and any file that
 * is not a PNG, or that this parser cannot walk cleanly, is handed over
 * untouched rather than mangled.
 */
const CRITICAL_PNG_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function stripPngMetadata(bytes: Buffer): Buffer {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return bytes;
  try {
    const kept: Buffer[] = [bytes.subarray(0, 8)];
    let offset = 8;
    let sawEnd = false;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      const end = offset + 12 + length;
      // A chunk that runs past the end of the file means this is not a
      // PNG we understand; hand the original back rather than emit a
      // truncated one.
      if (end > bytes.length) return bytes;
      if (CRITICAL_PNG_CHUNKS.has(type)) kept.push(bytes.subarray(offset, end));
      if (type === "IEND") {
        sawEnd = true;
        break;
      }
      offset = end;
    }
    return sawEnd ? Buffer.concat(kept) : bytes;
  } catch {
    return bytes;
  }
}

/**
 * Draws `spec.text` onto `baseImage` and returns PNG bytes at the size
 * the spec's aspect calls for. Pure and cheap — re-rendering after a
 * text edit costs nothing and calls no API.
 */
export async function renderOverlay(
  baseImage: Buffer,
  spec: OverlaySpec,
  customFontPath?: string | null
): Promise<Buffer> {
  const family = requireFont(customFontPath);
  const { width, height } = frameSize(coerceAspect(spec.aspect));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const img = await loadImage(stripPngMetadata(baseImage));
  // cover-fit: fill the frame, crop the overflow, never letterbox.
  const scale = Math.max(width / img.width, height / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  ctx.drawImage(img, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);

  const text = spec.uppercase ? spec.text.toLocaleUpperCase() : spec.text;
  if (text.trim()) {
    drawHeadline(ctx, text, spec, family, width, height);
  }

  return canvas.toBuffer("image/png");
}

/**
 * The headline alone on transparency, at the same size and position as
 * the composited cover.
 *
 * This is the layer-export escape hatch: someone finishing a cover in
 * Photoshop or Canva wants the background and the type as separate
 * files, and re-typing the headline by hand there loses the exact
 * placement the profile chose. Costs nothing — no model is involved.
 */
export async function renderTextLayer(
  spec: OverlaySpec,
  customFontPath?: string | null
): Promise<Buffer> {
  const family = requireFont(customFontPath);
  const { width, height } = frameSize(coerceAspect(spec.aspect));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const text = spec.uppercase ? spec.text.toLocaleUpperCase() : spec.text;
  if (text.trim()) {
    drawHeadline(ctx, text, spec, family, width, height);
  }

  return canvas.toBuffer("image/png");
}

function requireFont(customFontPath?: string | null): string {
  const chosenPath = resolveFontPath(customFontPath);
  const family = registerFont(chosenPath);
  if (!family) {
    throw new Error(
      `The thumbnail font could not be loaded from ${chosenPath} — text overlay is unavailable.`
    );
  }
  return family;
}

type Ctx2D = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

function drawHeadline(
  ctx: Ctx2D,
  text: string,
  spec: OverlaySpec,
  family: string,
  width: number,
  height: number
): void {
  const margin = Math.round(width * MARGIN_RATIO);
  // A headline anchored to one side gets HALF the frame to wrap in, not
  // all of it.
  //
  // You only push a headline to the left or the right when something
  // else owns the other side — on this channel it is a face, and the
  // covers that won put 2-3 words in the empty corner beside it. Wrapping
  // at full frame width let those words run straight across the subject,
  // which is what "the text overlaps everything" meant. The narrower box
  // makes the size search land smaller and break the line earlier, so the
  // block stays in its own corner.
  //
  // Centre zones keep the whole width: text centred on the frame is a
  // deliberate full-width design, not a corner. A banner (`plate`) is
  // drawn edge to edge by definition, so it keeps the full width too.
  const sideAnchored = /(^|-)(left|right)$/.test(spec.zone);
  const boxWidth = Math.round(
    (width - margin * 2) * (sideAnchored && !spec.plate ? SIDE_ZONE_WIDTH_RATIO : 1)
  );
  const boxHeight = height * clamp(spec.maxHeightRatio, 0.1, 0.6);

  // Binary-search the largest size at which the wrapped text still fits
  // its box. Beats stepping down by 2px: a 3-word headline and a
  // 12-word one both land on their true maximum in ~8 iterations.
  //
  // The ceiling scales with the frame's SHORT edge — on a 9:16 cover the
  // limit is how wide a word can be, not how tall the frame is.
  const shortEdge = Math.min(width, height);
  let lo = Math.round(shortEdge * MIN_FONT_RATIO);
  let hi = Math.round(shortEdge * MAX_FONT_RATIO);
  let best = lo;
  let bestLines: string[] = [text];
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    ctx.font = `800 ${mid}px ${family}`;
    const lines = wrapText(ctx, text, boxWidth);
    const stackHeight = lines.length * mid * LINE_SPACING;
    // Height alone is not enough. A single word wider than the box
    // cannot be wrapped away, so without the width test the search
    // happily returns a size whose longest line runs off both edges --
    // which is what a tall 9:16 frame produces, since its height budget
    // is generous enough to never bite first.
    const widest = Math.max(
      ...lines.map((l) => ctx.measureText(l).width),
      0
    );
    if (stackHeight <= boxHeight && widest <= boxWidth) {
      best = mid;
      bestLines = lines;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // The search cannot go below its own floor, so an extremely long
  // single word (a hashtag, a German compound) can still be too wide at
  // the smallest searched size. Step it down rather than let it bleed
  // off the frame.
  let fontSize = best;
  for (let guard = 0; guard < 40 && fontSize > 8; guard++) {
    ctx.font = `800 ${fontSize}px ${family}`;
    const lines = wrapText(ctx, text, boxWidth);
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
    if (widest <= boxWidth) {
      bestLines = lines;
      break;
    }
    fontSize = Math.floor(fontSize * 0.9);
  }

  ctx.font = `800 ${fontSize}px ${family}`;
  const lineHeight = fontSize * LINE_SPACING;
  const blockHeight = bestLines.length * lineHeight;

  const { x, y, align } = zoneAnchor(spec.zone, blockHeight, {
    width,
    height,
    margin,
  });

  // The banner hugs the words rather than crossing the whole frame.
  //
  // It used to be drawn edge to edge, on the assumption that a channel
  // using a banner uses a full-width strip. Vlad's crime channel says
  // otherwise, and its own winners are the evidence: "162 IQ HITMAN"
  // puts black type on a torn white block over the left half, "Black
  // Devil" has no block at all, and only the newspaper-style cover runs
  // a bar across the top — where the TEXT is that wide anyway. Hugging
  // the block reproduces all three; a full-bleed strip reproduces one
  // and paints over the artwork in the other two.
  if (spec.plate) {
    const padY = fontSize * 0.28;
    const padX = fontSize * 0.42;
    const widest = Math.max(...bestLines.map((l) => ctx.measureText(l).width), 0);
    // Left edge of the type block, derived from where it is anchored —
    // the same three cases zoneAnchor works in.
    const blockLeft =
      align === "left" ? x : align === "right" ? x - widest : x - widest / 2;
    const plateLeft = Math.max(0, blockLeft - padX);
    const plateRight = Math.min(width, blockLeft + widest + padX);
    ctx.fillStyle = spec.plateColor || "#D01B1B";
    ctx.fillRect(plateLeft, y - padY, plateRight - plateLeft, blockHeight + padY * 2);
  }

  ctx.textAlign = align;
  ctx.textBaseline = "top";

  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  bestLines.forEach((line, i) => {
    const lineY = y + i * lineHeight;
    if (spec.shadow) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = fontSize * 0.22;
      ctx.shadowOffsetY = fontSize * 0.06;
      ctx.fillStyle = spec.color;
      ctx.fillText(line, x, lineY);
      ctx.restore();
    }
    if (spec.stroke && spec.strokeColor) {
      ctx.strokeStyle = spec.strokeColor;
      ctx.lineWidth = Math.max(3, fontSize * 0.11);
      ctx.strokeText(line, x, lineY);
    }
    ctx.fillStyle = spec.color;
    ctx.fillText(line, x, lineY);
  });
}

function zoneAnchor(
  zone: TextZone,
  blockHeight: number,
  frame: { width: number; height: number; margin: number }
): { x: number; y: number; align: "left" | "center" | "right" } {
  const top = frame.margin;
  const middle = (frame.height - blockHeight) / 2;
  const bottom = frame.height - frame.margin - blockHeight;
  const left = frame.margin;
  const centerX = frame.width / 2;
  const right = frame.width - frame.margin;

  switch (zone) {
    case "top-left":
      return { x: left, y: top, align: "left" };
    case "top-center":
      return { x: centerX, y: top, align: "center" };
    case "top-right":
      return { x: right, y: top, align: "right" };
    case "left":
      return { x: left, y: middle, align: "left" };
    case "center":
      return { x: centerX, y: middle, align: "center" };
    case "right":
      return { x: right, y: middle, align: "right" };
    case "bottom-center":
      return { x: centerX, y: bottom, align: "center" };
    case "bottom-right":
      return { x: right, y: bottom, align: "right" };
    case "bottom-left":
    default:
      return { x: left, y: bottom, align: "left" };
  }
}

/**
 * Greedy word wrap. A word longer than the whole line (a URL, a German
 * compound) is kept on its own line rather than split mid-word — the
 * font-size search then shrinks until it fits.
 */
function wrapText(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
