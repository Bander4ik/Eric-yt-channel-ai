import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  getActiveImageProvider,
  listThumbnailRuns,
  listThumbnailVariants,
} from "@/lib/db";
import { runGeneration } from "@/lib/thumbnail-generate";
import { preflight } from "@/lib/thumbnail-preflight";
import {
  DEFAULT_VARIANTS,
  MAX_VARIANTS,
} from "@/lib/image-provider-types";
import { coerceZone } from "@/lib/thumbnail-overlay-types";
import {
  finishJob,
  isJobRunning,
  jobKey,
  progressJob,
  readJob,
  startJob,
  THUMBNAIL_GEN_JOB,
} from "@/lib/settings-job";
import { log } from "@/lib/logger";

/**
 * Thumbnail generation for one title.
 *
 * POST starts a survivable job; GET reports its progress plus the latest
 * run's variants. The work itself lives in `thumbnail-generate.ts` so
 * the batch route runs byte-for-byte the same pipeline.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

type Body = {
  channelId?: unknown;
  sourceKind?: unknown;
  sourceId?: unknown;
  title?: unknown;
  userNote?: unknown;
  variants?: unknown;
  prompt?: unknown;
  overlayText?: unknown;
  zone?: unknown;
};

const SOURCE_KINDS = ["idea", "signal", "video_remix", "manual"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelId = url.searchParams.get("channelId") || getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "No active channel selected." }, { status: 400 });
  }

  const latest = listThumbnailRuns(channelId, 1)[0];

  return NextResponse.json({
    channelId,
    job: readJob(jobKey(THUMBNAIL_GEN_JOB, channelId)),
    latestRun: latest
      ? {
          ...latest,
          referenceIds: safeParseArray(latest.reference_ids),
          variants: listThumbnailVariants(latest.id),
        }
      : null,
    hasProvider: !!getActiveImageProvider(),
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

  const pre = preflight(channelId);
  if (!pre.ok) {
    return NextResponse.json({ error: pre.error }, { status: pre.status });
  }

  const sourceKind: SourceKind =
    typeof body.sourceKind === "string" &&
    (SOURCE_KINDS as readonly string[]).includes(body.sourceKind)
      ? (body.sourceKind as SourceKind)
      : "manual";

  const variants = clampInt(body.variants, DEFAULT_VARIANTS, 1, MAX_VARIANTS);

  const key = jobKey(THUMBNAIL_GEN_JOB, channelId);
  if (isJobRunning(key)) {
    return NextResponse.json(
      { error: "A generation is already running for this channel." },
      { status: 409 }
    );
  }

  startJob(key, variants, "planning");
  log.info("thumbnails", "Generation started", {
    channelId,
    provider: pre.providerRow.provider,
    model: pre.providerRow.model,
    variants,
    title,
  });

  // Fire-and-forget: the run finishes on the server whether or not the
  // tab stays open.
  void (async () => {
    try {
      const result = await runGeneration({
        channelId,
        claudeKey: pre.claudeKey,
        providerRow: pre.providerRow,
        profile: pre.profile,
        title,
        sourceKind,
        sourceId:
          typeof body.sourceId === "string" || typeof body.sourceId === "number"
            ? String(body.sourceId)
            : null,
        userNote: typeof body.userNote === "string" ? body.userNote : null,
        variants,
        reusePrompt: typeof body.prompt === "string" ? body.prompt : null,
        overlayText:
          typeof body.overlayText === "string" ? body.overlayText : null,
        zone: body.zone !== undefined ? coerceZone(body.zone) : null,
        onProgress: (p) =>
          progressJob(key, {
            stage: p.stage,
            done: p.done,
            failed: p.failed,
            resultId: p.runId ?? null,
            lastError: p.lastError ?? null,
          }),
      });

      finishJob(key, {
        done: result.done,
        failed: result.failed,
        lastError: result.lastError,
        resultId: result.runId,
        stage: result.modelRendersText
          ? `done — text drawn by the model (${result.uncovered
              .slice(0, 6)
              .join("")} is outside the available font)`
          : "done",
      });
      log.info("thumbnails", "Generation finished", {
        channelId,
        runId: result.runId,
        done: result.done,
        failed: result.failed,
        costCents: result.costCents,
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

