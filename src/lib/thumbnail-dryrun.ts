import "server-only";
import { createCanvas } from "@napi-rs/canvas";
import type { ThumbnailStyleProfile } from "./thumbnail-style";

/**
 * Dry-run mode: exercise the whole thumbnail pipeline without spending
 * anything.
 *
 * Set THUMBNAILS_DRY_RUN=1 and every paid call is replaced by a local
 * stand-in — the style analysis returns a canned profile, the prompt
 * builder returns a deterministic prompt, and the image provider paints
 * a placeholder. Everything else runs for real: winner selection, job
 * progress, file writes, text compositing, variant rows, cost
 * accounting, the UI.
 *
 * This exists because the two halves of this feature fail differently.
 * The half that talks to Anthropic and to an image provider can only be
 * proven with a live key. The half that is plumbing — does the job
 * survive a reload, does the overlay land on disk, does picking a
 * variant reach the Board — is most of the code and needs no key at all.
 * Without this switch that plumbing would ship on the strength of unit
 * checks and an argument, which is not the same as having watched it
 * work end to end.
 *
 * Every placeholder is visibly labelled DRY RUN so nobody can mistake
 * one for a real generation, and runs made this way record no cost.
 */

export function isDryRun(): boolean {
  return process.env.THUMBNAILS_DRY_RUN === "1";
}

/**
 * A style profile with the shape the real analysis returns, filled from
 * the sample sizes actually found so the UI shows honest counts. Traits
 * say plainly that they came from a dry run.
 */
export function dryRunProfile(input: {
  ownIds: string[];
  competitorIds: string[];
}): ThumbnailStyleProfile {
  const all = [...input.ownIds, ...input.competitorIds];
  const trait = (summary: string) => ({
    summary,
    n: all.length,
    evidence: all,
  });
  return {
    composition: {
      ...trait("DRY RUN — no model was called. Subject left of centre, headline zone kept clear."),
      textZone: "bottom-left",
    },
    palette: {
      ...trait("DRY RUN — high-contrast warm subject against a cool background."),
      dominant: ["#E4572E", "#17223B"],
    },
    subject: {
      ...trait("DRY RUN — single dominant object filling roughly half the frame."),
      facePresent: false,
      recurringElement: null,
    },
    textTreatment: {
      ...trait("DRY RUN — two or three words, uppercase, heavy weight, stroked."),
      wordCountBand: "2-3",
      uppercase: true,
      stroke: true,
      shadow: true,
    },
    mood: trait("DRY RUN — dramatic, high stakes."),
    avoid: ["DRY RUN — this profile is a placeholder, not an analysis."],
    caveats: [
      "Generated with THUMBNAILS_DRY_RUN=1. No thumbnails were looked at. Re-run the analysis with a Claude key for a real profile.",
    ],
  };
}

/** The prompt a dry run pretends the planner produced. */
export function dryRunPrompt(title: string): string {
  return `DRY RUN placeholder prompt for "${title}". No model was called.`;
}

/**
 * A placeholder image, distinct per variant index so a four-variant run
 * is visibly four different pictures rather than one repeated — which is
 * exactly what a broken loop would look like.
 */
export function dryRunImage(index: number, title: string): Buffer {
  const width = 1536;
  const height = 864;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const hue = (index * 67) % 360;
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, `hsl(${hue}, 55%, 22%)`);
  grad.addColorStop(1, `hsl(${(hue + 40) % 360}, 65%, 45%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // A shape that moves with the index, so a cover-fit crop bug or an
  // off-by-one in the variant loop is visible at a glance.
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(
    width * (0.25 + 0.15 * (index % 4)),
    height * 0.4,
    height * 0.22,
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, width, 92);
  ctx.fillStyle = "#ffffff";
  ctx.font = "48px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(`DRY RUN · variant ${index + 1}`, 40, 46);
  ctx.font = "32px sans-serif";
  ctx.fillText(title.slice(0, 60), 40, height - 48);

  return canvas.toBuffer("image/png");
}
