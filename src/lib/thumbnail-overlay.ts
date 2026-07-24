import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
} from "./image-provider-types";
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

const MARGIN = 56;
const LINE_SPACING = 1.06;

/**
 * Draws `spec.text` onto `baseImage` and returns PNG bytes at the
 * YouTube thumbnail size. Pure and cheap — re-rendering after a text
 * edit costs nothing and calls no API.
 */
export async function renderOverlay(
  baseImage: Buffer,
  spec: OverlaySpec,
  customFontPath?: string | null
): Promise<Buffer> {
  const chosenPath = resolveFontPath(customFontPath);
  const family = registerFont(chosenPath);
  if (!family) {
    throw new Error(
      `The thumbnail font could not be loaded from ${chosenPath} — text overlay is unavailable.`
    );
  }

  const canvas = createCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const ctx = canvas.getContext("2d");

  const img = await loadImage(baseImage);
  // cover-fit: fill the frame, crop the overflow, never letterbox.
  const scale = Math.max(
    THUMBNAIL_WIDTH / img.width,
    THUMBNAIL_HEIGHT / img.height
  );
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  ctx.drawImage(
    img,
    (THUMBNAIL_WIDTH - drawW) / 2,
    (THUMBNAIL_HEIGHT - drawH) / 2,
    drawW,
    drawH
  );

  const text = spec.uppercase ? spec.text.toLocaleUpperCase() : spec.text;
  if (text.trim()) {
    drawHeadline(ctx, text, spec, family);
  }

  return canvas.toBuffer("image/png");
}

type Ctx2D = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;

function drawHeadline(
  ctx: Ctx2D,
  text: string,
  spec: OverlaySpec,
  family: string
): void {
  const boxWidth = THUMBNAIL_WIDTH - MARGIN * 2;
  const boxHeight = THUMBNAIL_HEIGHT * clamp(spec.maxHeightRatio, 0.1, 0.6);

  // Binary-search the largest size at which the wrapped text still fits
  // its box. Beats stepping down by 2px: a 3-word headline and a
  // 12-word one both land on their true maximum in ~8 iterations.
  let lo = 24;
  let hi = 220;
  let best = lo;
  let bestLines: string[] = [text];
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    ctx.font = `800 ${mid}px ${family}`;
    const lines = wrapText(ctx, text, boxWidth);
    const height = lines.length * mid * LINE_SPACING;
    if (height <= boxHeight) {
      best = mid;
      bestLines = lines;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const fontSize = best;
  ctx.font = `800 ${fontSize}px ${family}`;
  const lineHeight = fontSize * LINE_SPACING;
  const blockHeight = bestLines.length * lineHeight;

  const { x, y, align } = zoneAnchor(spec.zone, blockHeight);
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
  blockHeight: number
): { x: number; y: number; align: "left" | "center" | "right" } {
  const top = MARGIN;
  const middle = (THUMBNAIL_HEIGHT - blockHeight) / 2;
  const bottom = THUMBNAIL_HEIGHT - MARGIN - blockHeight;
  const left = MARGIN;
  const centerX = THUMBNAIL_WIDTH / 2;
  const right = THUMBNAIL_WIDTH - MARGIN;

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
