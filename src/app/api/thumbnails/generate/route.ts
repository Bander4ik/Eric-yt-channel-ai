import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  createThumbnailRun,
  createThumbnailVariant,
  DATA_DIR,
  getActiveChannelId,
  getActiveImageProvider,
  getIntegration,
  getThumbnailStyleProfile,
  listBrandAssets,
  listThumbnailRuns,
  listThumbnailVariants,
  setThumbnailRunCost,
} from "@/lib/db";
import {
  buildGenerationPlan,
  collectReferenceThumbnails,
  safeSegment,
  type ThumbnailStyleProfile,
} from "@/lib/thumbnail-style";
import {
  generateImages,
  type ImageUsage,
  type ReferenceImage,
} from "@/lib/image-provider";
import {
  DEFAULT_VARIANTS,
  isImageProviderChoice,
  MAX_VARIANTS,
  type ImageProviderChoice,
} from "@/lib/image-provider-types";
import { measuredRunCostCents } from "@/lib/thumbnail-pricing";
import {
  coerceZone,
  DEFAULT_OVERLAY,
  fontCovers,
  renderOverlay,
  uncoveredCharacters,
  type OverlaySpec,
} from "@/lib/thumbnail-overlay";
import {
  finishJob,
  isJobRunning,
  jobKey,
  progressJob,
  readJob,
  startJob,
} from "@/lib/settings-job";
import { log } from "@/lib/logger";

/**
 * Thumbnail generation.
 *
 * POST starts a survivable job; GET reports its progress plus the latest
 * run's variants. The job writes progress after every variant so a
 * reload mid-run shows "2 of 4" rather than starting over.
 *
 * A failed variant is recorded and the run continues — one refused
 * prompt shouldn't cost the user the other three images they paid for.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

const JOB_BASE = "thumbnail.gen.job";

type Body = {
  channelId?: unknown;
  sourceKind?: unknown;
  sourceId?: unknown;
  title?: unknown;
  userNote?: unknown;
  variants?: unknown;
  /** Supplied when re-running an edited prompt — skips the planning call. */
  prompt?: unknown;
  overlayText?: unknown;
  zone?: unknown;
};

const SOURCE_KINDS = ["idea", "signal", "video_remix", "manual"] as const;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId") || getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  const runs = listThumbnailRuns(channelId, 1);
  const latest = runs[0];
  const provider = getActiveImageProvider();

  return NextResponse.json({
    channelId,
    job: readJob(jobKey(JOB_BASE, channelId)),
    latestRun: latest
      ? {
          ...latest,
          referenceIds: safeParseArray(latest.reference_ids),
          variants: listThumbnailVariants(latest.id),
        }
      : null,
    hasProvider: !!provider,
  });
}

function safeParseArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const channelId =
    (typeof body.channelId === "string" && body.channelId) ||
    getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json(
      { error: "A video title is required — a thumbnail needs something to be about." },
      { status: 400 }
    );
  }

  const sourceKind =
    typeof body.sourceKind === "string" &&
    (SOURCE_KINDS as readonly string[]).includes(body.sourceKind)
      ? body.sourceKind
      : "manual";

  const claudeKey = getIntegration("claude")?.api_key;
  if (!claudeKey) {
    return NextResponse.json(
      { error: "Claude API key is not configured. Add it in Integrations." },
      { status: 400 }
    );
  }

  const providerRow = getActiveImageProvider();
  if (!providerRow) {
    return NextResponse.json(
      {
        error:
          "No image provider is configured. Add one in Integrations and make it active.",
      },
      { status: 400 }
    );
  }
  const provider: ImageProviderChoice = isImageProviderChoice(providerRow.provider)
    ? providerRow.provider
    : "gemini";

  const profileRow = getThumbnailStyleProfile(channelId);
  if (!profileRow) {
    return NextResponse.json(
      {
        error:
          "Analyse this channel's thumbnail style first — generation without it would be guesswork.",
      },
      { status: 400 }
    );
  }
  let profile: ThumbnailStyleProfile;
  try {
    profile = JSON.parse(profileRow.profile_json) as ThumbnailStyleProfile;
  } catch {
    return NextResponse.json(
      { error: "The stored style profile is unreadable — re-run the analysis." },
      { status: 400 }
    );
  }

  const variants = clampInt(body.variants, DEFAULT_VARIANTS, 1, MAX_VARIANTS);

  const key = jobKey(JOB_BASE, channelId);
  if (isJobRunning(key)) {
    return NextResponse.json(
      { error: "A generation is already running for this channel." },
      { status: 409 }
    );
  }

  startJob(key, variants, "planning");
  log.info("thumbnails", "Generation started", {
    channelId,
    provider,
    model: providerRow.model,
    variants,
    title,
  });

  void (async () => {
    try {
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
          const abs = path.join(DATA_DIR, asset.file_path);
          characterRefs.push({
            bytes: fs.readFileSync(abs),
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

      // The headline decides whether we composite the text or make the
      // image model draw it: our bundled font covers Latin, Cyrillic and
      // Greek, and silently rendering tofu boxes for anything else would
      // be worse than handing the job to the model.
      const provisionalHeadline =
        typeof body.overlayText === "string" && body.overlayText.trim()
          ? body.overlayText.trim()
          : title;
      const modelRendersText = !fontCovers(provisionalHeadline);

      progressJob(key, { stage: "writing the prompt" });

      const reusedPrompt =
        typeof body.prompt === "string" && body.prompt.trim()
          ? body.prompt.trim()
          : null;

      const plan = reusedPrompt
        ? {
            prompt: reusedPrompt,
            overlayCandidates: [provisionalHeadline],
            zone: coerceZone(body.zone ?? profile.composition.textZone),
          }
        : await buildGenerationPlan({
            apiKey: claudeKey,
            profile,
            title,
            userNote:
              typeof body.userNote === "string" ? body.userNote : null,
            brandAssetDescriptions: assets.map(
              (a) => `${a.kind}${a.label ? ` (${a.label})` : ""}`
            ),
            headlineZone: body.zone ? coerceZone(body.zone) : undefined,
            modelRendersText,
          });

      const headline =
        typeof body.overlayText === "string" && body.overlayText.trim()
          ? body.overlayText.trim()
          : plan.overlayCandidates[0] ?? title;

      const runId = createThumbnailRun({
        channelId,
        sourceKind,
        sourceId:
          typeof body.sourceId === "string" || typeof body.sourceId === "number"
            ? String(body.sourceId)
            : null,
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
      progressJob(key, { resultId: runId, stage: "generating" });

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

          const baseRel = path.posix.join(
            "thumbnails",
            safeSegment(channelId),
            String(runId),
            `${i}-base.png`
          );
          fs.writeFileSync(path.join(DATA_DIR, baseRel), image.bytes);

          let finalRel: string | null = null;
          let overlayJson: string | null = null;
          if (modelRendersText) {
            // The model drew the headline itself — compositing on top of
            // it would double the text.
            finalRel = baseRel;
          } else {
            const composited = await renderOverlay(image.bytes, overlaySpec);
            finalRel = path.posix.join(
              "thumbnails",
              safeSegment(channelId),
              String(runId),
              `${i}-final.png`
            );
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
          createThumbnailVariant({ runId, idx: i, error: lastError });
          log.warn("thumbnails", "Variant failed", {
            channelId,
            runId,
            index: i,
            error: lastError,
          });
        }
        progressJob(key, { done, failed, lastError, stage: "generating" });
      }

      // Cost is recorded only from what the provider actually reported.
      // When it reports nothing, the column stays NULL and the UI says
      // so, rather than passing the estimate off as measured.
      const cost = measuredRunCostCents(
        provider,
        providerRow.model ?? "",
        usages
      );
      if (cost !== null) setThumbnailRunCost(runId, cost);

      finishJob(key, {
        done,
        failed,
        lastError,
        resultId: runId,
        stage: modelRendersText
          ? `done — text drawn by the model (${uncoveredCharacters(headline)
              .slice(0, 6)
              .join("")} is outside the bundled font)`
          : "done",
      });
      log.info("thumbnails", "Generation finished", {
        channelId,
        runId,
        done,
        failed,
        costCents: cost,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("thumbnails", `Generation failed: ${message}`, err, { channelId });
      finishJob(key, { lastError: message, stage: "failed" });
    }
  })();

  return NextResponse.json({ ok: true, started: true, variants });
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function mimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}
