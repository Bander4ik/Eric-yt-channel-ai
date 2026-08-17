import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude-driven OCR for YouTube thumbnail images. Thumbnails routinely carry
 * the creator's actual hook copy ("3 SECRETS NOBODY TELLS YOU") baked into
 * the pixels — text a normal transcript/description pass never sees. This
 * module fetches one thumbnail image, hands it to Claude as an image block,
 * and asks for a single-line transcription of whatever text is printed on
 * it. The batch route (thumbnails-ocr) calls this once per video and writes
 * the result into `videos.thumbnail_text` so it can be searched/analyzed
 * alongside titles and descriptions.
 */

const OCR_MODEL = "claude-sonnet-5";

/**
 * Two questions, not one: what the text says, and whether it is the
 * cover's HEADLINE at all.
 *
 * The old prompt asked only for "the text", so a listicle cover came
 * back as its ten tile captions — "LONG SKULL / TINY BODY / HORNED
 * SKULL / …" — and everything downstream treated that as the channel's
 * headline copy. The packaging stats then reported the most frequent
 * words in a pile of tile nouns as if it were a finding about what makes
 * people click. Naming the kind lets the rest of the app count only what
 * can be counted, and say so when it skipped something.
 */
const OCR_PROMPT =
  "Read the text on this YouTube thumbnail and answer in exactly two lines.\n" +
  "Line 1: KIND: headline | labels | none\n" +
  "  headline — one prominent line or block of overlaid words, added on top " +
  "of the picture, meant to be read at a glance at thumbnail size.\n" +
  "  labels — the text belongs to the artwork rather than sitting on top " +
  "of it: captions naming the items in a grid or list, a sign, a chart " +
  "legend, a name tag, a price on a product. Several small pieces scattered " +
  "over the image are labels, not a headline. If a cover has BOTH a " +
  "headline and labels, answer headline.\n" +
  "  none — no readable text at all.\n" +
  "Line 2: TEXT: the exact visible text, original casing, separate blocks " +
  "joined with ' / '. For headline, give the headline only, not the labels. " +
  "For none, write NONE.\n" +
  "Do not describe the image. Do not add anything else.";

export class ThumbnailOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailOcrError";
  }
}

type SupportedImageMediaType = "image/jpeg" | "image/png" | "image/webp";

function mediaTypeFromContentType(contentType: string | null): SupportedImageMediaType {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "image/png") return "image/png";
  if (type === "image/webp") return "image/webp";
  // Default to jpeg — YouTube thumbnails are jpeg the overwhelming majority
  // of the time, and it's the safest fallback when the header is missing
  // or reports something Claude's image blocks don't accept.
  return "image/jpeg";
}

/**
 * Fetch one thumbnail image and ask Claude to transcribe whatever text is
 * printed on it. Returns "" when the thumbnail has no overlaid text at all
 * (the model's explicit NONE signal) — never returns the literal "NONE".
 *
 * Single attempt, no retries: the caller (the batch route) treats each
 * video independently and keeps going on a per-item failure.
 */
export async function ocrThumbnail(
  thumbnailUrl: string,
  apiKey: string
): Promise<OcrResult> {
  const res = await fetch(thumbnailUrl);
  if (!res.ok) {
    throw new ThumbnailOcrError(`Thumbnail fetch ${res.status}`);
  }

  const mediaType = mediaTypeFromContentType(res.headers.get("content-type"));
  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = buffer.toString("base64");

  const client = new Anthropic({ apiKey });
  let raw: string;
  try {
    const response = await client.messages.create({
      model: OCR_MODEL,
      max_tokens: 300,
      // Sonnet 5 defaults to adaptive thinking, which would consume this tiny
      // 300-token budget before any OCR text comes out — keep it disabled.
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            { type: "text", text: OCR_PROMPT },
          ],
        },
      ],
    });
    raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (e) {
    throw new ThumbnailOcrError(
      `Claude call failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return parseOcrAnswer(raw);
}

export type OcrResult = {
  text: string;
  kind: "headline" | "labels" | "none";
};

/**
 * Tolerant on purpose. A model that ignores the two-line shape and just
 * returns the words still gives us usable copy, and calling that a
 * headline keeps the old behaviour rather than silently dropping a
 * channel's text out of every stat.
 */
export function parseOcrAnswer(raw: string): OcrResult {
  const trimmed = raw.trim();
  if (!trimmed) return { text: "", kind: "none" };

  const kindMatch = trimmed.match(/^\s*KIND:\s*(headline|labels|none)\b/im);
  const textMatch = trimmed.match(/^\s*TEXT:\s*([\s\S]*)$/im);

  const kind = (kindMatch?.[1]?.toLowerCase() ?? "headline") as OcrResult["kind"];
  const body = (textMatch ? textMatch[1] : trimmed).trim();

  if (kind === "none" || body.toUpperCase() === "NONE" || !body) {
    return { text: "", kind: "none" };
  }
  return { text: body.replace(/\s*\n+\s*/g, " / "), kind };
}

