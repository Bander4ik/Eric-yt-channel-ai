import { NextResponse } from "next/server";
import {
  getActiveTranscriptionJob,
  getIntegration,
  getSetting,
  getVideo,
  recordDeepgramUsage,
  upsertTranscript,
} from "@/lib/db";
import { transcribeFromUrl, DeepgramError } from "@/lib/deepgram";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/videos/:id/transcribe-url
 * Body: { audioUrl: string }
 *
 * Hands the URL to Deepgram, which fetches the audio from there
 * itself. Use for publicly accessible Drive/Dropbox/S3/CDN links —
 * Deepgram is the one talking to that host, not Railway, so this
 * sidesteps any datacenter-IP blocks on the source.
 *
 * Validates the URL shape but not its reachability — if Deepgram
 * can't fetch, we surface their error verbatim.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const video = getVideo(id);
  if (!video) {
    return NextResponse.json({ error: "video not found" }, { status: 404 });
  }

  const apiKey = getIntegration("deepgram")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Deepgram API key is not configured. Add it in Settings." },
      { status: 400 }
    );
  }

  const activeJob = getActiveTranscriptionJob();
  if (activeJob) {
    return NextResponse.json(
      {
        error:
          "A batch transcription is currently running. Wait for it to finish before transcribing from URL.",
      },
      { status: 409 }
    );
  }
  if (getSetting("sync.inProgress") === "1") {
    return NextResponse.json(
      { error: "A channel sync is currently running. Try again in a few seconds." },
      { status: 409 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { audioUrl?: string };
  const audioUrl = (body.audioUrl ?? "").trim();
  if (!audioUrl) {
    return NextResponse.json({ error: "audioUrl required" }, { status: 400 });
  }
  try {
    // Light shape validation so we don't pass garbage to Deepgram.
    const parsed = new URL(audioUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return NextResponse.json(
        { error: "audioUrl must use http:// or https://" },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "audioUrl is not a valid URL" },
      { status: 400 }
    );
  }

  const startedAt = Date.now();
  try {
    const result = await transcribeFromUrl(audioUrl, apiKey);
    upsertTranscript(id, result.text, result.language);
    recordDeepgramUsage({
      videoId: id,
      durationSeconds: result.durationSeconds,
      costCents: result.costCents,
      model: result.model,
    });
    log.info("deepgram", "Video transcribed from URL", {
      videoId: id,
      audioUrl: audioUrl.slice(0, 200),
      durationSeconds: result.durationSeconds,
      costCents: result.costCents,
      language: result.language,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      ok: true,
      videoId: id,
      durationSeconds: result.durationSeconds,
      costCents: result.costCents,
      language: result.language,
      textLength: result.text.length,
      source: "url",
    });
  } catch (err) {
    const status = err instanceof DeepgramError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("deepgram", `URL transcription failed: ${message}`, err, {
      videoId: id,
      audioUrl: audioUrl.slice(0, 200),
    });
    return NextResponse.json({ error: message }, { status });
  }
}
