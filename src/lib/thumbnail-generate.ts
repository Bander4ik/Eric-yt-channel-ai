import "server-only";
import fs from "node:fs";
import path from "node:path";
import {
  createThumbnailRun,
  createThumbnailVariant,
  DATA_DIR,
  getChannelFontPath,
  listBrandAssets,
  setThumbnailRunCost,
  type ImageProviderRow,
} from "./db";
import {
  buildGenerationPlan,
  collectReferenceThumbnails,
  safeSegment,
  type ThumbnailStyleProfile,
} from "./thumbnail-style";
import {
  generateImages,
  type ImageUsage,
  type ReferenceImage,
} from "./image-provider";
import { isImageProviderChoice, type ImageProviderChoice } from "./image-provider-types";
import { measuredRunCostCents } from "./thumbnail-pricing";
import {
  coerceZone,
  DEFAULT_OVERLAY,
  fontCovers,
  renderOverlay,
  uncoveredCharacters,
  type OverlaySpec,
  type TextZone,
} from "./thumbnail-overlay";
import { log } from "./logger";

/**
 * One generation run, start to finish.
 *
 * Extracted from the route so the single-title path and the batch path
 * cannot drift apart: whatever the batch produces is produced by exactly
 * the same code as a single click, including the reference selection,
 * the derive-don't-copy prompt, the font coverage decision and the cost
 * accounting.
 *
 * The caller owns the job bookkeeping; this function only reports
 * progress through the callback it is given.
 */

export type RunGenerationInput = {
  channelId: string;
  claudeKey: string;
  providerRow: ImageProviderRow;
  profile: ThumbnailStyleProfile;
  title: string;
  sourceKind: "idea" | "signal" | "video_remix" | "manual";
  sourceId?: string | null;
  userNote?: string | null;
  variants: number;
  /** Supplied when re-running an edited prompt — skips the planning call. */
  reusePrompt?: string | null;
  overlayText?: string | null;
  zone?: TextZone | null;
  onProgress?: (p: {
    stage: string;
    done: number;
    failed: number;
    runId?: number;
    lastError?: string | null;
  }) => void;
};

export type RunGenerationResult = {
  runId: number;
  done: number;
  failed: number;
  costCents: number | null;
  modelRendersText: boolean;
  uncovered: string[];
  lastError: string | null;
};

export async function runGeneration(
  input: RunGenerationInput
): Promise<RunGenerationResult> {
  const {
    channelId,
    claudeKey,
    providerRow,
    profile,
    title,
    variants,
  } = input;
  const provider: ImageProviderChoice = isImageProviderChoice(providerRow.provider)
    ? providerRow.provider
    : "gemini";
  const report = input.onProgress ?? (() => {});

  const refs = await collectReferenceThumbnails(channelId);
  const styleRefs: ReferenceImage[] = [
    ...refs.own.map((r) => ({
      bytes: r.bytes,
      mimeType: r.mimeType,
      label: `own:${r.videoId} ${r.multiplier.toFixed(1)}x`,
    })),
    ...refs.competitor.map((r) => ({
      bytes: r.bytes,
      mimeType: r.mimeType,
      label: `competitor:${r.videoId} ${r.multiplier.toFixed(1)}x`,
    })),
  ];

  const assets = listBrandAssets(channelId).filter((a) => a.kind !== "font");
  const characterRefs: ReferenceImage[] = [];
  for (const asset of assets) {
    try {
      characterRefs.push({
        bytes: fs.readFileSync(path.join(DATA_DIR, asset.file_path)),
        mimeType: mimeFromPath(asset.file_path),
        label: `${asset.kind}:${asset.label ?? asset.id}`,
      });
    } catch (err) {
      log.warn("thumbnails", "Brand asset unreadable, skipping", {
        assetId: asset.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Whether we composite the headline or the image model draws it comes
  // down to one question: does the font we have actually carry these
  // glyphs? Rendering tofu boxes would be worse than handing the job to
  // the model, so the check happens before anything is paid for.
  const fontRel = getChannelFontPath(channelId);
  const fontAbs = fontRel ? path.join(DATA_DIR, fontRel) : null;
  const provisionalHeadline = input.overlayText?.trim() || title;
  const modelRendersText = !fontCovers(provisionalHeadline, fontAbs);

  report({ stage: "writing the prompt", done: 0, failed: 0 });

  const plan = input.reusePrompt?.trim()
    ? {
        prompt: input.reusePrompt.trim(),
        overlayCandidates: [provisionalHeadline],
        zone: coerceZone(input.zone ?? profile.composition.textZone),
      }
    : await buildGenerationPlan({
        apiKey: claudeKey,
        profile,
        title,
        userNote: input.userNote ?? null,
        brandAssetDescriptions: assets.map(
          (a) => `${a.kind}${a.label ? ` (${a.label})` : ""}`
        ),
        headlineZone: input.zone ?? undefined,
        modelRendersText,
      });

  const headline = input.overlayText?.trim() || plan.overlayCandidates[0] || title;

  const runId = createThumbnailRun({
    channelId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId ?? null,
    title,
    prompt: plan.prompt,
    provider,
    model: providerRow.model ?? "",
    variants,
    referenceIds: [
      ...refs.own.map((r) => r.videoId),
      ...refs.competitor.map((r) => r.videoId),
    ],
  });
  report({ stage: "generating", done: 0, failed: 0, runId });

  const runDir = path.join(
    DATA_DIR,
    "thumbnails",
    safeSegment(channelId),
    String(runId)
  );
  fs.mkdirSync(runDir, { recursive: true });

  const overlaySpec: OverlaySpec = {
    ...DEFAULT_OVERLAY,
    text: headline,
    zone: plan.zone,
    uppercase: profile.textTreatment.uppercase,
    stroke: profile.textTreatment.stroke,
    shadow: profile.textTreatment.shadow,
  };

  const usages: Array<ImageUsage | undefined> = [];
  let done = 0;
  let failed = 0;
  let lastError: string | null = null;

  for (let i = 0; i < variants; i++) {
    try {
      const { images } = await generateImages({
        provider,
        apiKey: providerRow.api_key,
        model: providerRow.model ?? "",
        prompt: plan.prompt,
        styleRefs,
        characterRefs,
        count: 1,
      });
      const image = images[0];
      usages.push(image.usage);

      const baseRel = relPath(channelId, runId, `${i}-base.png`);
      fs.writeFileSync(path.join(DATA_DIR, baseRel), image.bytes);

      let finalRel: string;
      let overlayJson: string | null = null;
      if (modelRendersText) {
        // The model drew the headline itself — compositing on top would
        // double the text.
        finalRel = baseRel;
      } else {
        const composited = await renderOverlay(image.bytes, overlaySpec, fontAbs);
        finalRel = relPath(channelId, runId, `${i}-final.png`);
        fs.writeFileSync(path.join(DATA_DIR, finalRel), composited);
        overlayJson = JSON.stringify(overlaySpec);
      }

      createThumbnailVariant({
        runId,
        idx: i,
        basePath: baseRel,
        finalPath: finalRel,
        overlayJson,
      });
      done++;
    } catch (err) {
      failed++;
      lastError = err instanceof Error ? err.message : String(err);
      // A failed variant keeps its row so the UI can say which one broke
      // and why, instead of silently returning three of four.
      createThumbnailVariant({ runId, idx: i, error: lastError });
      log.warn("thumbnails", "Variant failed", {
        channelId,
        runId,
        index: i,
        error: lastError,
      });
    }
    report({ stage: "generating", done, failed, runId, lastError });
  }

  const costCents = measuredRunCostCents(provider, providerRow.model ?? "", usages);
  if (costCents !== null) setThumbnailRunCost(runId, costCents);

  return {
    runId,
    done,
    failed,
    costCents,
    modelRendersText,
    uncovered: modelRendersText ? uncoveredCharacters(headline, fontAbs) : [],
    lastError,
  };
}

function relPath(channelId: string, runId: number, file: string): string {
  return path.posix.join(
    "thumbnails",
    safeSegment(channelId),
    String(runId),
    file
  );
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}
