import "server-only";
import fs from "node:fs";
import path from "node:path";
import {
  createThumbnailRun,
  createThumbnailVariant,
  DATA_DIR,
  getChannelFontPath,
  getThumbnailStyleProfile,
  listBrandAssets,
  listRecentChannelTitles,
  setThumbnailRunCost,
  setThumbnailRunCredits,
  type ImageProviderRow,
} from "./db";
import {
  buildGenerationPlan,
  channelUsesHeadline,
  collectReferenceThumbnails,
  safeSegment,
  type AnalysisProvider,
  type ThumbnailStyleProfile,
} from "./thumbnail-style";
import {
  generateImages,
  type ImageUsage,
  type ReferenceImage,
} from "./image-provider";
import {
  DEFAULT_ASPECT,
  findModelOption,
  isImageProviderChoice,
  type AspectChoice,
  type ImageProviderChoice,
} from "./image-provider-types";
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
  analyser: AnalysisProvider;
  providerRow: ImageProviderRow;
  profile: ThumbnailStyleProfile;
  title: string;
  sourceKind: "idea" | "signal" | "video_remix" | "manual";
  sourceId?: string | null;
  userNote?: string | null;
  variants: number;
  /** 16:9 long-form cover (default) or 9:16 for Shorts. */
  aspect?: AspectChoice;
  /**
   * Which of the channel's winning looks to build for. Omitted means the
   * strongest one, which is also the only one an older profile has.
   */
  formatIndex?: number | null;
  /** Supplied when re-running an edited prompt — skips the planning call. */
  reusePrompt?: string | null;
  overlayText?: string | null;
  zone?: TextZone | null;
  /**
   * Who letters the headline.
   *
   * "model" — the image model writes it, copying how this channel's own
   * covers letter theirs. This is what makes a cover look like the
   * channel rather than like this app, and it is the only way one
   * product can serve a newspaper-style crime channel and a glossy
   * science channel without hard-coding either.
   *
   * "overlay" — we draw it. One bundled font, always spelled right,
   * re-editable for free forever.
   *
   * A script our font cannot render forces "model" whatever is asked.
   */
  headlineMode?: "model" | "overlay" | "none" | null;
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
    providerRow,
    profile,
    title,
    variants,
  } = input;
  const provider: ImageProviderChoice = isImageProviderChoice(providerRow.provider)
    ? providerRow.provider
    : "gemini";
  const aspect: AspectChoice = input.aspect ?? DEFAULT_ASPECT;
  const report = input.onProgress ?? (() => {});

  // Use the SAME age window the channel's saved style profile was built
  // with, so the pictures we hand the image model can never disagree
  // with the profile describing them. A profile built pre-migration (or
  // deliberately at "all time") has window_months = NULL, and that's
  // preserved as-is here rather than guessed at -- an old profile really
  // was built from the full history, and narrowing it now would change
  // a user's results with no explanation.
  const windowMonths = getThumbnailStyleProfile(channelId)?.window_months ?? null;
  const refs = await collectReferenceThumbnails(channelId, windowMonths);
  const woven = weaveReferences(
    refs.own.map((r) => ({
      videoId: r.videoId,
      ref: {
        bytes: r.bytes,
        mimeType: r.mimeType,
        label: `own:${r.videoId} ${r.multiplier.toFixed(1)}x`,
        sourceUrl: r.sourceUrl,
      },
    })),
    refs.competitor.map((r) => ({
      videoId: r.videoId,
      ref: {
        bytes: r.bytes,
        mimeType: r.mimeType,
        label: `competitor:${r.videoId} ${r.multiplier.toFixed(1)}x`,
        sourceUrl: r.sourceUrl,
      },
    }))
  );

  // Cap here rather than leaving it to the provider adapter, so what the
  // run records as "references sent" is what was actually sent. The panel
  // that names them is a transparency claim; it must not list images the
  // model never saw.
  const modelOption = findModelOption(provider, providerRow.model);
  const sent = woven.slice(0, modelOption.maxStyleRefs);
  const styleRefs: ReferenceImage[] = sent.map((w) => w.ref);

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
  // Two ways to end up with the model lettering the cover, and they are
  // not the same thing. The first is forced: our font has no glyphs for
  // this script, and drawing tofu boxes would be worse than asking the
  // model. The second is chosen: the caller wants the headline to look
  // like the channel's own, which our single bundled font can never do
  // for every channel at once. Either way the compositor stands down,
  // because drawing on top of a headline the model already wrote gives
  // you two.
  // A channel whose winners carry no words gets none. The measurement
  // already knew this — the word band comes back as "0-1" with a note
  // like "minimal to no text overlay" — and we lettered a headline over
  // it anyway, which is the fastest way to make a cover stop looking
  // like the channel it was built from. An explicit choice still wins;
  // this is only what happens when nobody asked for anything.
  const mode: "model" | "overlay" | "none" =
    input.headlineMode ?? (channelUsesHeadline(profile) ? "model" : "none");
  const wantsHeadline = mode !== "none";
  const modelRendersText =
    wantsHeadline &&
    (!fontCovers(provisionalHeadline, fontAbs) || mode === "model");

  report({ stage: "writing the prompt", done: 0, failed: 0 });

  const plan = input.reusePrompt?.trim()
    ? {
        prompt: input.reusePrompt.trim(),
        overlayCandidates: [provisionalHeadline],
        zone: coerceZone(input.zone ?? profile.composition.textZone),
      }
    : await buildGenerationPlan({
        analyser: input.analyser,
        profile,
        title,
        aspect,
        formatIndex: input.formatIndex ?? null,
        channelTitles: listRecentChannelTitles(channelId),
        userNote: input.userNote ?? null,
        // Announced to the prompt writer only when this model can actually
        // receive them. kie.ai takes reference images by public URL only,
        // so an uploaded character has nowhere to go and its
        // maxCharacterRefs is 0 — promising the prompt a character that
        // never gets attached is worse than not mentioning it.
        brandAssetDescriptions:
          modelOption.maxCharacterRefs > 0
            ? assets.map((a) => `${a.kind}${a.label ? ` (${a.label})` : ""}`)
            : [],
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
    aspect,
    referenceIds: sent.map((w) => w.videoId),
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
    aspect,
    uppercase: profile.textTreatment.uppercase,
    stroke: profile.textTreatment.stroke,
    shadow: profile.textTreatment.shadow,
    plate: profile.textTreatment.plate,
    plateColor:
      profile.textTreatment.plateColor ?? DEFAULT_OVERLAY.plateColor,
    color: profile.textTreatment.textColor ?? DEFAULT_OVERLAY.color,
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
        aspect,
        // One image per call, so the provider has to be told which
        // variant this is or every one of them gets the same prompt.
        variantIndex: i,
      });
      const image = images[0];
      usages.push(image.usage);

      // Providers return whatever format they like — kie hands back JPEG.
      // Writing that into a .png would hand the user a file whose name
      // lies about its contents, which matters the moment they open the
      // background layer in an editor.
      const baseRel = relPath(
        channelId,
        runId,
        `${i}-base${extensionFor(image.mimeType)}`
      );
      fs.writeFileSync(path.join(DATA_DIR, baseRel), image.bytes);

      let finalRel: string;
      let overlayJson: string | null = null;
      let warning: string | null = null;
      if (modelRendersText || !wantsHeadline) {
        // The model drew the headline itself — compositing on top would
        // double the text.
        finalRel = baseRel;
      } else {
        try {
          const composited = await renderOverlay(
            image.bytes,
            overlaySpec,
            fontAbs
          );
          finalRel = relPath(channelId, runId, `${i}-final.png`);
          fs.writeFileSync(path.join(DATA_DIR, finalRel), composited);
          overlayJson = JSON.stringify(overlaySpec);
        } catch (overlayErr) {
          // The image exists and has already been paid for. Losing it
          // because a caption could not be drawn is the worst possible
          // trade — a client hit exactly this and saw four failures with
          // four perfectly good covers sitting on disk beside them. Hand
          // the background over as the result and say what is missing;
          // "Re-render overlay" can add the text later for free once the
          // underlying cause is fixed.
          finalRel = baseRel;
          warning =
            "Background generated, but the headline could not be drawn on it: " +
            (overlayErr instanceof Error
              ? overlayErr.message
              : String(overlayErr));
          log.warn("thumbnails", "Overlay failed, keeping the background", {
            channelId,
            runId,
            index: i,
            provider,
            model: providerRow.model ?? "",
            // What the provider SAID it sent, how much arrived, and how
            // the payload actually starts. "Invalid SVG image" means the
            // bytes began with SVG markup that would not parse -- a
            // truncated download and a provider answering with vector
            // markup look identical until you see the head of it, and
            // without these three fields the next report is another
            // guessing game.
            mimeType: image.mimeType,
            bytes: image.bytes.length,
            head: image.bytes.subarray(0, 80).toString("utf8"),
            error: warning,
          });
        }
      }

      createThumbnailVariant({
        runId,
        idx: i,
        basePath: baseRel,
        finalPath: finalRel,
        overlayJson,
        warning,
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
        // Which provider and model, always. A provider's own wording is
        // passed through verbatim here, and the same sentence can mean
        // completely different things depending on who said it — the
        // report that started this said only "Invalid SVG image".
        provider,
        model: providerRow.model ?? "",
        referencesSent: styleRefs.length + characterRefs.length,
        error: lastError,
      });
    }
    report({ stage: "generating", done, failed, runId, lastError });
  }

  const costCents = measuredRunCostCents(provider, providerRow.model ?? "", usages);
  if (costCents !== null) setThumbnailRunCost(runId, costCents);

  // kie.ai reports credits rather than money and publishes no rate for
  // every model. Credits are what the provider actually measured, so they
  // are recorded and shown; turning them into dollars would mean invented
  // a rate, which is the one thing the cost column must never contain.
  const credits = usages.reduce((sum, u) => sum + (u?.credits ?? 0), 0);
  if (credits > 0) {
    setThumbnailRunCredits(runId, credits);
    log.info("thumbnails", "Run billed in provider credits", {
      runId,
      provider,
      model: providerRow.model,
      credits,
    });
  }

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

/**
 * Orders style references so a provider's cap cannot silently drop one
 * whole side of the evidence.
 *
 * Every model caps how many style images it accepts, and kie's is three.
 * Concatenating own-then-competitor meant those three slots always went
 * to own thumbnails, so competitor winners never reached the image model
 * at all — the brief asks for exactly the opposite, and the UI was
 * naming references that had been sliced off before the request.
 *
 * Own first, then alternating, so the top own winner still leads and the
 * top competitor is in by the second slot.
 */
function weaveReferences<T>(own: T[], competitor: T[]): T[] {
  const woven: T[] = [];
  for (let i = 0; i < Math.max(own.length, competitor.length); i++) {
    if (own[i] !== undefined) woven.push(own[i]);
    if (competitor[i] !== undefined) woven.push(competitor[i]);
  }
  return woven;
}

function relPath(channelId: string, runId: number, file: string): string {
  return path.posix.join(
    "thumbnails",
    safeSegment(channelId),
    String(runId),
    file
  );
}

/** File extension for what the provider actually sent back. */
function extensionFor(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  return ".png";
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

