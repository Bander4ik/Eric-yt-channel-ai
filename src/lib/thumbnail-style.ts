import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  listCompetitorThumbnailWinners,
  listOwnThumbnailWinners,
  recordClaudeUsage,
  type ThumbnailWinner,
} from "./db";
import { costMillicents } from "./claude-pricing";
import { log } from "./logger";
import { coerceZone, type TextZone } from "./thumbnail-overlay";
import { dryRunProfile, dryRunPrompt, isDryRun } from "./thumbnail-dryrun";

/**
 * Where a channel's thumbnail style comes from, and how it turns into a
 * prompt.
 *
 * The pipeline has two halves and they are kept strictly apart:
 *
 *   DETERMINISTIC — which thumbnails count as winners, and by how much.
 *   That is SQL over live view counts (see `listOwnThumbnailWinners` /
 *   `listCompetitorThumbnailWinners` in db.ts), using the same maturity
 *   and sample-size guards the Packaging tab already applies. No model
 *   gets a vote in what "successful" means.
 *
 *   DESCRIPTIVE — what those winners have in common visually. That needs
 *   eyes, so Claude looks at the images and reports the pattern. It is
 *   told the multipliers and is required to attribute every trait to the
 *   videos that support it, so the profile can be audited against the
 *   database by hand.
 *
 * The statistical rule the rest of the app follows applies here too:
 * fewer than MIN_WINNERS confirmed winners does not make a rule. The
 * profile is still produced — a new channel deserves something — but it
 * is flagged low-confidence and the UI says so before the user spends
 * money on it.
 */

const ANALYZER_MODEL = "claude-sonnet-4-6";
const PROMPT_MODEL = "claude-sonnet-4-6";

/** Matches FORMULA_MIN_USES in packaging.ts — one bar across the app. */
export const MIN_WINNERS = 5;

export const MAX_OWN_REFS = 12;
export const MAX_COMPETITOR_REFS = 12;

/** A cached profile older than this is recomputed on the next visit. */
export const PROFILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type StyleTrait = {
  summary: string;
  n: number;
  evidence: string[];
};

export type ThumbnailStyleProfile = {
  composition: StyleTrait & { textZone: TextZone };
  palette: StyleTrait & { dominant: string[] };
  subject: StyleTrait & { facePresent: boolean; recurringElement: string | null };
  textTreatment: StyleTrait & {
    wordCountBand: string;
    uppercase: boolean;
    stroke: boolean;
    shadow: boolean;
  };
  mood: StyleTrait;
  avoid: string[];
  caveats: string[];
};

export type ReferenceThumbnail = {
  videoId: string;
  title: string;
  multiplier: number;
  source: "own" | "competitor";
  sourceLabel: string;
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
};

/* ------------------------------------------------------------------ *
 * Reference images
 * ------------------------------------------------------------------ */

function refsDir(channelId: string): string {
  return path.join(DATA_DIR, "thumbnails", "_refs", safeSegment(channelId));
}

/** Keeps a channel id from ever escaping its folder. */
export function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

function mediaTypeFor(
  contentType: string | null
): "image/jpeg" | "image/png" | "image/webp" {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "image/png") return "image/png";
  if (type === "image/webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Download a winner's thumbnail, caching it on disk. Cached because the
 * same handful of images is read by both the analysis pass and every
 * later generation run, and YouTube's image CDN doesn't need the traffic.
 *
 * Tries the maxres file first and falls back to the stored URL — maxres
 * is absent for a good share of older videos and returns a 404 rather
 * than a smaller image.
 */
async function fetchThumbnail(
  channelId: string,
  videoId: string,
  url: string
): Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp" }> {
  const dir = refsDir(channelId);
  fs.mkdirSync(dir, { recursive: true });
  const cached = path.join(dir, `${safeSegment(videoId)}.img`);
  const metaFile = `${cached}.type`;

  if (fs.existsSync(cached) && fs.existsSync(metaFile)) {
    return {
      bytes: fs.readFileSync(cached),
      mimeType: mediaTypeFor(fs.readFileSync(metaFile, "utf8")),
    };
  }

  const candidates = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    url,
  ];
  let lastError = "no candidate URL succeeded";
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate);
      if (!res.ok) {
        lastError = `HTTP ${res.status} for ${candidate}`;
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const mimeType = mediaTypeFor(res.headers.get("content-type"));
      fs.writeFileSync(cached, bytes);
      fs.writeFileSync(metaFile, mimeType);
      return { bytes, mimeType };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`could not fetch a thumbnail for ${videoId}: ${lastError}`);
}

export type CollectProgress = (done: number, total: number) => void;

/**
 * Winners plus their image bytes, ready for the model. Individual
 * download failures are skipped rather than aborting — one dead CDN
 * entry must not cost the user the whole analysis.
 */
export async function collectReferenceThumbnails(
  channelId: string,
  onProgress?: CollectProgress
): Promise<{ own: ReferenceThumbnail[]; competitor: ReferenceThumbnail[] }> {
  const ownWinners = listOwnThumbnailWinners(channelId, MAX_OWN_REFS);
  const compWinners = listCompetitorThumbnailWinners(
    channelId,
    MAX_COMPETITOR_REFS
  );
  const total = ownWinners.length + compWinners.length;
  let done = 0;

  const load = async (
    winners: ThumbnailWinner[],
    source: "own" | "competitor"
  ): Promise<ReferenceThumbnail[]> => {
    const out: ReferenceThumbnail[] = [];
    for (const w of winners) {
      if (w.thumbnailUrl) {
        try {
          const { bytes, mimeType } = await fetchThumbnail(
            channelId,
            w.videoId,
            w.thumbnailUrl
          );
          out.push({
            videoId: w.videoId,
            title: w.title,
            multiplier: w.multiplier,
            source,
            sourceLabel: w.sourceLabel,
            bytes,
            mimeType,
          });
        } catch (err) {
          log.warn("thumbnails", "Reference thumbnail download failed", {
            videoId: w.videoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      done++;
      onProgress?.(done, total);
    }
    return out;
  };

  return {
    own: await load(ownWinners, "own"),
    competitor: await load(compWinners, "competitor"),
  };
}

/* ------------------------------------------------------------------ *
 * Vision analysis
 * ------------------------------------------------------------------ */

const ANALYSIS_INSTRUCTIONS = `You are analysing YouTube thumbnails that are PROVEN to outperform their channel's median views. Your job is to describe the visual pattern they share — not to praise them, not to invent a brand strategy.

Each image is labelled with its view multiplier against its own channel's median. Higher multiplier = stronger evidence.

Rules you must follow:
- Describe only what you can SEE in these specific images.
- A trait supported by fewer than ${MIN_WINNERS} images belongs in "caveats", not stated as a rule.
- Every trait must list the video ids that support it in "evidence", and "n" must equal that list's length.
- Do not name any specific video's subject matter as a rule. You are extracting visual GRAMMAR (composition, colour, typography, subject scale, mood), not topics.
- Write in plain English. This gets shown to the channel owner.

Return ONLY a JSON object, no prose and no code fence, in exactly this shape:

{
  "composition": { "summary": string, "textZone": "top-left"|"top-center"|"top-right"|"left"|"center"|"right"|"bottom-left"|"bottom-center"|"bottom-right", "n": number, "evidence": string[] },
  "palette": { "summary": string, "dominant": string[], "n": number, "evidence": string[] },
  "subject": { "summary": string, "facePresent": boolean, "recurringElement": string|null, "n": number, "evidence": string[] },
  "textTreatment": { "summary": string, "wordCountBand": string, "uppercase": boolean, "stroke": boolean, "shadow": boolean, "n": number, "evidence": string[] },
  "mood": { "summary": string, "n": number, "evidence": string[] },
  "avoid": string[],
  "caveats": string[]
}

"dominant" is 2-4 hex colours. "textZone" is where the headline sits in most of them. "wordCountBand" is like "2-3" or "4-6". "avoid" is what these winners consistently do NOT do.`;

export async function analyseThumbnailStyle(input: {
  apiKey: string;
  own: ReferenceThumbnail[];
  competitor: ReferenceThumbnail[];
}): Promise<{ profile: ThumbnailStyleProfile; model: string }> {
  const all = [...input.own, ...input.competitor];
  if (all.length === 0) {
    throw new Error(
      "No thumbnails to analyse — sync this channel's videos first, and add competitors on the Competitors tab."
    );
  }

  if (isDryRun()) {
    return {
      profile: dryRunProfile({
        ownIds: input.own.map((r) => r.videoId),
        competitorIds: input.competitor.map((r) => r.videoId),
      }),
      model: "dry-run",
    };
  }

  const content: Anthropic.MessageParam["content"] = [];
  for (const ref of all) {
    content.push({
      type: "text",
      text: `[${ref.videoId}] ${ref.source === "own" ? "OWN CHANNEL" : `COMPETITOR: ${ref.sourceLabel}`} — ${ref.multiplier.toFixed(1)}x its channel median — "${ref.title}"`,
    });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: ref.mimeType,
        data: ref.bytes.toString("base64"),
      },
    });
  }
  content.push({ type: "text", text: ANALYSIS_INSTRUCTIONS });

  const client = new Anthropic({ apiKey: input.apiKey });
  const started = Date.now();
  const response = await client.messages.create({
    model: ANALYZER_MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content }],
  });

  recordAnalysisUsage(response, ANALYZER_MODEL, started, "thumbnail style analysis");

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return { profile: normaliseProfile(parseJsonObject(raw)), model: ANALYZER_MODEL };
}

/**
 * The model returns JSON, but a stray code fence or a leading sentence
 * shouldn't cost the user a paid call. Take the outermost braces.
 */
function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("The style analysis did not return JSON.");
  }
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * Defensive normalisation. Every field is coerced to the shape the UI
 * renders, and `n` is recomputed from the evidence array rather than
 * trusted — a model that claims n=9 while listing three ids would
 * otherwise turn a caveat into a rule.
 */
function normaliseProfile(raw: Record<string, unknown>): ThumbnailStyleProfile {
  const trait = (key: string): StyleTrait => {
    const t = (raw[key] ?? {}) as Record<string, unknown>;
    const evidence = Array.isArray(t.evidence)
      ? (t.evidence as unknown[]).map(String)
      : [];
    return {
      summary: typeof t.summary === "string" ? t.summary : "",
      evidence,
      n: evidence.length,
    };
  };

  const composition = raw.composition as Record<string, unknown> | undefined;
  const palette = raw.palette as Record<string, unknown> | undefined;
  const subject = raw.subject as Record<string, unknown> | undefined;
  const textTreatment = raw.textTreatment as Record<string, unknown> | undefined;

  return {
    composition: { ...trait("composition"), textZone: coerceZone(composition?.textZone) },
    palette: {
      ...trait("palette"),
      dominant: Array.isArray(palette?.dominant)
        ? (palette!.dominant as unknown[]).map(String).slice(0, 4)
        : [],
    },
    subject: {
      ...trait("subject"),
      facePresent: subject?.facePresent === true,
      recurringElement:
        typeof subject?.recurringElement === "string"
          ? (subject.recurringElement as string)
          : null,
    },
    textTreatment: {
      ...trait("textTreatment"),
      wordCountBand:
        typeof textTreatment?.wordCountBand === "string"
          ? (textTreatment.wordCountBand as string)
          : "2-3",
      uppercase: textTreatment?.uppercase !== false,
      stroke: textTreatment?.stroke !== false,
      shadow: textTreatment?.shadow !== false,
    },
    mood: trait("mood"),
    avoid: Array.isArray(raw.avoid) ? (raw.avoid as unknown[]).map(String) : [],
    caveats: Array.isArray(raw.caveats)
      ? (raw.caveats as unknown[]).map(String)
      : [],
  };
}

/* ------------------------------------------------------------------ *
 * Prompt construction
 * ------------------------------------------------------------------ */

export type GenerationPlan = {
  prompt: string;
  overlayCandidates: string[];
  zone: TextZone;
};

const PROMPT_INSTRUCTIONS = `You write prompts for an image generation model that will produce a YouTube thumbnail BACKGROUND, plus the short headline that will be composited on top of it afterwards.

Critical constraints:
- The image model must DERIVE the visual grammar from the reference images it is given. It must NOT reproduce any single reference's subject, layout or specific scene. Say this explicitly in the prompt.
- The image must contain NO TEXT, NO LETTERING, NO WATERMARKS and no logos. The headline is added later by a separate renderer. State this in the prompt.
- Leave the headline zone visually calm — no busy detail there — so overlaid text stays readable.
- Aspect ratio is 16:9, and the composition must survive being viewed at 210x118 pixels.
- Write the headline candidates in the SAME LANGUAGE as the video title you are given. Never translate it to English.

Return ONLY a JSON object, no prose and no code fence:

{
  "prompt": string,
  "overlayCandidates": [string, string, string],
  "zone": "top-left"|"top-center"|"top-right"|"left"|"center"|"right"|"bottom-left"|"bottom-center"|"bottom-right"
}

"prompt" is one paragraph, concrete and visual. "overlayCandidates" are three headline options for the thumbnail, each within the channel's observed word-count band — punchy, not a restatement of the full title. "zone" is where the headline should sit.`;

export async function buildGenerationPlan(input: {
  apiKey: string;
  profile: ThumbnailStyleProfile;
  title: string;
  userNote?: string | null;
  brandAssetDescriptions: string[];
  headlineZone?: TextZone;
  /** True when the bundled font can't render this script, so the image
   *  model has to draw the text itself. Changes the prompt materially. */
  modelRendersText: boolean;
}): Promise<GenerationPlan> {
  if (isDryRun()) {
    return {
      prompt: dryRunPrompt(input.title),
      overlayCandidates: [input.title],
      zone: input.headlineZone ?? input.profile.composition.textZone,
    };
  }

  const client = new Anthropic({ apiKey: input.apiKey });
  const started = Date.now();

  const brandLine = input.brandAssetDescriptions.length
    ? `The channel supplies these recurring brand assets as reference images: ${input.brandAssetDescriptions.join("; ")}. Keep them recognisable.`
    : "The channel supplies no brand assets.";

  const textLine = input.modelRendersText
    ? `IMPORTANT OVERRIDE: this channel's language cannot be rendered by our text compositor, so the image model MUST draw the headline itself, spelled exactly as given. Include the exact headline text in the prompt, in quotes, and describe its treatment (${input.profile.textTreatment.uppercase ? "uppercase" : "sentence case"}, heavy weight, high contrast).`
    : "The image must contain no text at all.";

  const response = await client.messages.create({
    model: PROMPT_MODEL,
    max_tokens: 1200,
    messages: [
      {
        role: "user",
        content: `VIDEO TITLE: ${input.title}

CHANNEL STYLE PROFILE (derived from thumbnails that beat this channel's median):
${JSON.stringify(input.profile, null, 2)}

${brandLine}
${textLine}
${input.userNote ? `\nThe channel owner adds: ${input.userNote}` : ""}

${PROMPT_INSTRUCTIONS}`,
      },
    ],
  });

  recordAnalysisUsage(response, PROMPT_MODEL, started, "thumbnail prompt build");

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = parseJsonObject(raw);

  const candidates = Array.isArray(parsed.overlayCandidates)
    ? (parsed.overlayCandidates as unknown[]).map(String).filter(Boolean)
    : [];

  return {
    prompt:
      typeof parsed.prompt === "string" && parsed.prompt.trim()
        ? parsed.prompt.trim()
        : fallbackPrompt(input.profile, input.title),
    // Falling back to the raw title is better than an empty headline —
    // the user can edit it for free, and a blank cover is useless.
    overlayCandidates: candidates.length ? candidates : [input.title],
    zone: input.headlineZone ?? coerceZone(parsed.zone),
  };
}

/** Used only when the model returns an unusable prompt field. */
function fallbackPrompt(
  profile: ThumbnailStyleProfile,
  title: string
): string {
  return [
    `A 16:9 YouTube thumbnail background for a video titled "${title}".`,
    profile.composition.summary,
    profile.palette.summary,
    profile.subject.summary,
    profile.mood.summary,
    "Derive the visual grammar from the reference images without reproducing any single one of them.",
    "No text, no lettering, no logos, no watermarks anywhere in the image.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Thumbnail work spends the user's Claude key, so it shows up in the same
 * usage counter as everything else. sessionId is null because these calls
 * belong to no chat session; `firstUserMsg` carries the label so the
 * Integrations page can tell them apart.
 */
function recordAnalysisUsage(
  response: Anthropic.Message,
  model: string,
  startedAt: number,
  label: string
): void {
  try {
    const usage = response.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const inputFresh = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const inputCacheWrite = usage?.cache_creation_input_tokens ?? 0;
    const inputCacheRead = usage?.cache_read_input_tokens ?? 0;
    recordClaudeUsage({
      sessionId: null,
      executorModel: model,
      advisorModel: null,
      inputTokens: inputFresh,
      outputTokens: output,
      cacheWriteTokens: inputCacheWrite,
      cacheReadTokens: inputCacheRead,
      advisorInputTokens: 0,
      advisorOutputTokens: 0,
      advisorCalls: 0,
      costMillicents: costMillicents(model, {
        inputFresh,
        inputCacheWrite,
        inputCacheRead,
        output,
      }),
      durationMs: Date.now() - startedAt,
      iterations: 1,
      firstUserMsg: label,
      activeTools: [],
    });
  } catch (err) {
    // Usage accounting must never be the reason a generation fails.
    log.warn("thumbnails", "Could not record Claude usage", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
