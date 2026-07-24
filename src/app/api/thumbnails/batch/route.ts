import { NextResponse } from "next/server";
import {
  getActiveChannelId,
  listIdeas,
  listNicheHits,
} from "@/lib/db";
import { runGeneration } from "@/lib/thumbnail-generate";
import { preflight } from "@/lib/thumbnail-preflight";
import { coerceAspect } from "@/lib/image-provider-types";
import {
  finishJob,
  isJobRunning,
  jobKey,
  progressJob,
  startJob,
  THUMBNAIL_GEN_JOB,
} from "@/lib/settings-job";
import { log } from "@/lib/logger";

/**
 * Zero-input batch: the system picks what to make covers for.
 *
 * Two sources, both already curated by the rest of the app rather than
 * by a fresh guess — the oldest cards still sitting in the Board's
 * "idea" column, or the hottest niche hits by views-per-hour. The user
 * clicks once and comes back to a set of covers.
 *
 * It shares the single-generation job key on purpose: both spend the
 * same provider credit and write into the same run history, so starting
 * one while the other runs is a 409, not two concurrent spenders.
 *
 * Kept deliberately small — MAX_TITLES titles at MAX_VARIANTS_PER_TITLE
 * variants each — because this is the one button in the app that can
 * spend real money without the user naming what it is spending it on.
 */

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TITLES = 5;
const MAX_VARIANTS_PER_TITLE = 4;
const DEFAULT_TITLES = 3;
const DEFAULT_VARIANTS_PER_TITLE = 2;

type Body = {
  channelId?: unknown;
  source?: unknown;
  count?: unknown;
  variants?: unknown;
  aspect?: unknown;
};

type Seed = { title: string; sourceId: string | null; why: string };

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

  const pre = preflight(channelId);
  if (!pre.ok) {
    return NextResponse.json({ error: pre.error }, { status: pre.status });
  }

  const source = body.source === "signals" ? "signals" : "ideas";
  const count = clampInt(body.count, DEFAULT_TITLES, 1, MAX_TITLES);
  const variants = clampInt(
    body.variants,
    DEFAULT_VARIANTS_PER_TITLE,
    1,
    MAX_VARIANTS_PER_TITLE
  );

  const aspect = coerceAspect(body.aspect);
  const seeds = collectSeeds(source, count);
  if (seeds.length === 0) {
    return NextResponse.json(
      {
        error:
          source === "ideas"
            ? "No cards are sitting in the Board's Idea column — add some first, or batch from Signals instead."
            : "No niche hits to work from — run a Niche Watch scan on the Signals tab first.",
      },
      { status: 400 }
    );
  }

  const key = jobKey(THUMBNAIL_GEN_JOB, channelId);
  if (isJobRunning(key)) {
    return NextResponse.json(
      { error: "A generation is already running for this channel." },
      { status: 409 }
    );
  }

  const total = seeds.length * variants;
  startJob(key, total, `batch: 0/${seeds.length} titles`);
  log.info("thumbnails", "Batch generation started", {
    channelId,
    source,
    titles: seeds.length,
    variants,
  });

  void (async () => {
    let done = 0;
    let failed = 0;
    let lastError: string | null = null;
    let lastRunId: number | undefined;

    for (const [index, seed] of seeds.entries()) {
      try {
        const result = await runGeneration({
          channelId,
          analyser: pre.analyser,
          providerRow: pre.providerRow,
          profile: pre.profile,
          title: seed.title,
          sourceKind: source === "ideas" ? "idea" : "signal",
          sourceId: seed.sourceId,
          userNote: seed.why,
          variants,
          aspect,
          onProgress: (p) =>
            progressJob(key, {
              // Progress is cumulative across titles, so the bar means
              // "images produced" rather than resetting on each title.
              done: done + p.done,
              failed: failed + p.failed,
              stage: `batch: ${index + 1}/${seeds.length} — ${seed.title.slice(0, 48)}`,
              resultId: p.runId ?? lastRunId ?? null,
              lastError: p.lastError ?? lastError,
            }),
        });
        done += result.done;
        failed += result.failed;
        lastRunId = result.runId;
        if (result.lastError) lastError = result.lastError;
      } catch (err) {
        // One title failing must not cost the user the rest of the batch.
        failed += variants;
        lastError = err instanceof Error ? err.message : String(err);
        log.warn("thumbnails", "Batch title failed", {
          channelId,
          title: seed.title,
          error: lastError,
        });
      }
      progressJob(key, { done, failed, lastError });
    }

    finishJob(key, {
      done,
      failed,
      lastError,
      resultId: lastRunId ?? null,
      stage: `batch done — ${seeds.length} titles`,
    });
    log.info("thumbnails", "Batch generation finished", {
      channelId,
      done,
      failed,
    });
  })();

  return NextResponse.json({
    ok: true,
    started: true,
    titles: seeds.map((s) => s.title),
    total,
  });
}

/**
 * What to make covers for. Ideas come oldest-first within the Idea
 * column — the cards that have been waiting longest are the ones a
 * "just make me something" click should unblock. Signals come hottest
 * first by views-per-hour.
 */
function collectSeeds(source: "ideas" | "signals", count: number): Seed[] {
  if (source === "ideas") {
    return listIdeas()
      .filter((i) => i.stage === "idea")
      .sort((a, b) => a.position - b.position || a.created_at - b.created_at)
      .slice(0, count)
      .map((i) => ({
        title: i.title,
        sourceId: String(i.id),
        why: "Batch-generated from the Board.",
      }));
  }

  return listNicheHits(count * 3)
    .filter((h): h is typeof h & { title: string } => !!h.title)
    .slice(0, count)
    .map((h) => ({
      title: h.title,
      sourceId: h.videoId,
      // The hit is a COMPETITOR's video. The cover must be for the
      // user's own take on that subject, not a copy of that video's
      // packaging — say so in the note the prompt builder reads.
      why: `Seeded by a trending video in the "${h.nicheQuery}" niche (${Math.round(h.vph ?? 0)} views/hour). Make this the channel's own take on the subject, not a restaging of that video.`,
    }));
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

