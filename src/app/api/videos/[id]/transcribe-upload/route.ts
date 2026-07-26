import { NextResponse } from "next/server";
import {
  getActiveTranscriptionJob,
  getIntegration,
  getSetting,
  getVideo,
  recordDeepgramUsage,
  upsertTranscript,
} from "@/lib/db";
import { transcribeFromFileBuffer, DeepgramError } from "@/lib/deepgram";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
// Deepgram batch can take a minute or two on a long file plus the
// upload + their internal processing. 300s ceiling is what Railway
// allows; we leave the rest as headroom.
export const maxDuration = 300;

/**
 * POST /api/videos/:id/transcribe-upload
 *
 * Accepts a multipart/form-data body with a single `audio` field
 * containing the user's audio/video file. The file is buffered in
 * RAM (Railway's request size limit caps real-world uploads around
 * the 30 MB mark, which covers most short-to-medium audio files),
 * streamed straight to Deepgram, and the resulting transcript text
 * is persisted into the `transcripts` table. The file itself is
 * never written to disk on the server.
 *
 * This is the workaround for the YouTube datacenter wall: instead
 * of pulling audio FROM YouTube, the user provides the bytes
 * directly (e.g. exported from YouTube Studio, downloaded locally
 * via yt-dlp on their own machine, or any other source).
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

  // Same mutual exclusion guard the existing /transcribe endpoint uses
  // — batch jobs share the Deepgram quota and `transcripts` rows, so a
  // single-video upload mid-batch would race.
  const activeJob = getActiveTranscriptionJob();
  if (activeJob) {
    return NextResponse.json(
      {
        error:
          "A batch transcription is currently running. Wait for it to finish before uploading a single file.",
        jobId: activeJob.id,
      },
      { status: 409 }
    );
  }
  if (getSetting("sync.inProgress") === "1") {
    return NextResponse.json(
      {
        error:
          "A channel sync is currently running. Try again in a few seconds.",
      },
      { status: 409 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      {
        error: `Could not parse multipart body: ${
          e instanceof Error ? e.message : "unknown"
        }`,
      },
      { status: 400 }
    );
  }

  const file = form.get("audio");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { error: "Missing `audio` field in form data." },
      { status: 400 }
    );
  }
  // `file` is a Web `File` (extends Blob). Stream into a single Buffer
  // because Deepgram's pre-recorded `/v1/listen` wants a one-shot body.
  // Memory peak ≈ file size; ~30 MB for a typical 60-min mp3.
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  // Best-effort content type; Deepgram auto-detects from bytes anyway.
  const contentType =
    file.type && file.type !== "application/octet-stream"
      ? file.type
      : "audio/mpeg";

  const startedAt = Date.now();
  try {
    const result = await transcribeFromFileBuffer(buffer, contentType, apiKey);
    upsertTranscript(id, result.text, result.language);
    recordDeepgramUsage({
      videoId: id,
      durationSeconds: result.durationSeconds,
      costCents: result.costCents,
      model: result.model,
    });
    log.info("deepgram", "Video transcribed from uploaded file", {
      videoId: id,
      filename: file.name,
      fileSizeBytes: buffer.length,
      contentType,
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
      source: "upload",
    });
  } catch (err) {
    const status = err instanceof DeepgramError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("deepgram", `Upload transcription failed: ${message}`, err, {
      videoId: id,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
