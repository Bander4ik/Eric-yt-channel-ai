import "server-only";
import OpenAI, { toFile } from "openai";
import {
  DEFAULT_ASPECT,
  findModelOption,
  frameSize,
  frameSizeMultipleOf16,
  kieRequestShape,
  type AspectChoice,
  type ImageProviderChoice,
} from "./image-provider-types";
import { dryRunImage, isDryRun } from "./thumbnail-dryrun";

/**
 * Image-generation provider abstraction, shaped after `ai-provider.ts`.
 *
 * One call site (`/api/thumbnails/generate`) drives Gemini, OpenAI or fal
 * without branching, and each adapter is responsible for turning our
 * reference images into whatever that provider calls them.
 *
 * Three things are deliberately uniform across adapters:
 *
 *   1. We ask for ONE image per call and loop for variants, instead of
 *      using each provider's batch parameter. Providers disagree on
 *      whether `n > 1` returns diverse images or near-duplicates, and a
 *      per-image loop means a single failure costs one variant rather
 *      than the whole run.
 *   2. Every adapter returns raw bytes, never a URL. fal hands back a
 *      CDN link that expires; we fetch it here so the caller always
 *      writes a real file.
 *   3. Usage comes back when the provider reports it and is left
 *      undefined when it doesn't — the caller records a measured cost
 *      only from real numbers and shows "no cost data" otherwise,
 *      rather than silently substituting the estimate.
 *
 * NOTE ON VERIFICATION: the request shapes below follow each provider's
 * published documentation as of 2026-07-24. They have not been exercised
 * against a live key in this repo yet — the first real run is what turns
 * them from "documented" into "working".
 */

export interface GenerateImagesOpts {
  provider: ImageProviderChoice;
  apiKey: string;
  model: string;
  prompt: string;
  /** Winning thumbnails whose visual grammar the output should inherit. */
  styleRefs: ReferenceImage[];
  /** Brand assets — a recurring mascot, logo or frame. */
  characterRefs: ReferenceImage[];
  count: number;
  /** 16:9 long-form cover or 9:16 Shorts cover. Defaults to 16:9. */
  aspect?: AspectChoice;
  /**
   * Which variant of the run this call is producing.
   *
   * The caller asks for one image at a time (see the note above), so
   * without this every call would look like variant 0 to the nudge
   * table below and all four covers would come back from an identical
   * prompt — exactly the near-duplicate set the nudges exist to prevent.
   */
  variantIndex?: number;
}

export interface ReferenceImage {
  bytes: Buffer;
  mimeType: string;
  /** For logs and the transparency panel — never sent to the provider. */
  label: string;
  /**
   * Public URL this reference came from, when it has one. kie.ai accepts
   * reference images only as URLs, and our winners are public YouTube
   * thumbnails, so they can be passed straight through. Locally uploaded
   * brand assets have no URL and are skipped on that provider.
   */
  sourceUrl?: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  usage?: ImageUsage;
}

export interface ImageUsage {
  outputTokens?: number;
  inputTokens?: number;
  /** Set when the provider bills per image rather than per token. */
  images?: number;
  /** kie.ai bills in its own credits and reports them per task. */
  credits?: number;
}

export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ImageProviderChoice,
    readonly status?: number
  ) {
    super(message);
    this.name = "ImageProviderError";
  }
}

/**
 * Generate `count` images. Resolves with however many succeeded; throws
 * only when EVERY attempt failed, so a flaky provider can't turn a
 * partially good run into nothing.
 */
export async function generateImages(
  opts: GenerateImagesOpts
): Promise<{ images: GeneratedImage[]; errors: string[] }> {
  const images: GeneratedImage[] = [];
  const errors: string[] = [];

  // THUMBNAILS_DRY_RUN=1 short-circuits before any network call so the
  // rest of the pipeline can be exercised without a key. No usage is
  // reported, so the run correctly records no cost.
  const first = opts.variantIndex ?? 0;

  if (isDryRun()) {
    for (let i = 0; i < opts.count; i++) {
      images.push({
        bytes: dryRunImage(first + i, opts.prompt, opts.aspect ?? DEFAULT_ASPECT),
        mimeType: "image/png",
      });
    }
    return { images, errors };
  }

  for (let i = 0; i < opts.count; i++) {
    try {
      images.push(await generateOne(opts, first + i));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (images.length === 0) {
    throw new ImageProviderError(
      errors[0] ?? "image generation produced no output",
      opts.provider
    );
  }
  return { images, errors };
}

function generateOne(
  opts: GenerateImagesOpts,
  index: number
): Promise<GeneratedImage> {
  if (opts.provider === "gemini") return generateGemini(opts, index);
  if (opts.provider === "openai") return generateOpenAI(opts, index);
  if (opts.provider === "kie") return generateKie(opts, index);
  return generateFal(opts, index);
}

/**
 * Variants come from one prompt, so without a nudge some providers
 * return four near-identical frames. A short per-variant instruction is
 * cheaper and more reliable than fighting each SDK's seed parameter
 * (Gemini's Interactions API doesn't expose one at all).
 */
const VARIANT_NUDGES = [
  "",
  " Vary this take: different camera distance and subject placement from the obvious first choice.",
  " Vary this take: a different dominant colour from the palette and a different lighting direction.",
  " Vary this take: a bolder, more graphic composition with more negative space.",
  " Vary this take: tighter crop on the subject, higher contrast.",
  " Vary this take: wider establishing framing with the subject off-centre.",
  " Vary this take: a different focal object drawn from the same subject matter.",
  " Vary this take: flatter, more poster-like treatment.",
];

function promptForVariant(prompt: string, index: number): string {
  return prompt + (VARIANT_NUDGES[index % VARIANT_NUDGES.length] ?? "");
}

/** Reference images, capped to what the chosen model actually accepts. */
function cappedRefs(opts: GenerateImagesOpts): {
  style: ReferenceImage[];
  character: ReferenceImage[];
} {
  const model = findModelOption(opts.provider, opts.model);
  return {
    style: opts.styleRefs.slice(0, model.maxStyleRefs),
    character: opts.characterRefs.slice(0, model.maxCharacterRefs),
  };
}

// ---------------------------------------------------------------------------
// Google Gemini — Interactions API
// ---------------------------------------------------------------------------

const GEMINI_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

async function generateGemini(
  opts: GenerateImagesOpts,
  index: number
): Promise<GeneratedImage> {
  const { style, character } = cappedRefs(opts);

  const input: Array<Record<string, unknown>> = [
    { type: "text", text: promptForVariant(opts.prompt, index) },
  ];
  for (const ref of [...style, ...character]) {
    input.push({
      type: "image",
      mime_type: ref.mimeType,
      data: ref.bytes.toString("base64"),
    });
  }

  const res = await fetch(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      "x-goog-api-key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      input,
      response_modalities: ["image"],
      response_format: {
        type: "image",
        // The Interactions API accepts JPEG only, and answers a request
        // for png with a 400. Verified against the live API on
        // 2026-07-24. Losing nothing by it: the composited cover is
        // redrawn as PNG by our own renderer anyway.
        mime_type: "image/jpeg",
        aspect_ratio: opts.aspect ?? DEFAULT_ASPECT,
        image_size: "2K",
      },
    }),
  });

  if (!res.ok) {
    throw new ImageProviderError(
      `Gemini image request failed (${res.status}): ${truncate(await res.text())}`,
      "gemini",
      res.status
    );
  }

  const json = (await res.json()) as Record<string, unknown>;
  const found = extractGeminiImage(json);
  if (!found) {
    throw new ImageProviderError(
      "Gemini returned no image data — the model may have refused the prompt",
      "gemini"
    );
  }

  return {
    bytes: Buffer.from(found.data, "base64"),
    mimeType: found.mimeType,
    usage: extractGeminiUsage(json),
  };
}

/**
 * Pull the image out of a Gemini response.
 *
 * Two shapes are accepted on purpose. `output_image` is what the
 * Interactions API documents today; the `candidates[].content.parts[]`
 * walk is the older generateContent shape. Accepting both means a
 * provider-side rollout doesn't silently break generation for a user who
 * can't read our stack traces.
 */
function extractGeminiImage(
  json: Record<string, unknown>
): { data: string; mimeType: string } | null {
  // What the live Interactions API actually returns (verified
  // 2026-07-24): an ordered `steps` array, where the step of type
  // "model_output" carries content entries of type "image". The two
  // shapes below it are older and kept as fallbacks.
  const steps = json.steps as
    | Array<{ type?: string; content?: Array<Record<string, unknown>> }>
    | undefined;
  for (const step of steps ?? []) {
    for (const item of step.content ?? []) {
      const data = item.data as string | undefined;
      if (item.type === "image" && data) {
        return {
          data,
          mimeType: (item.mime_type as string) ?? "image/jpeg",
        };
      }
    }
  }

  const direct = json.output_image as
    | { data?: string; mime_type?: string }
    | undefined;
  if (direct?.data) {
    return { data: direct.data, mimeType: direct.mime_type ?? "image/png" };
  }

  const candidates = json.candidates as
    | Array<{ content?: { parts?: Array<Record<string, unknown>> } }>
    | undefined;
  for (const c of candidates ?? []) {
    for (const part of c.content?.parts ?? []) {
      const inline = (part.inlineData ?? part.inline_data) as
        | { data?: string; mimeType?: string; mime_type?: string }
        | undefined;
      if (inline?.data) {
        return {
          data: inline.data,
          mimeType: inline.mimeType ?? inline.mime_type ?? "image/png",
        };
      }
    }
  }
  return null;
}

function extractGeminiUsage(
  json: Record<string, unknown>
): ImageUsage | undefined {
  const usage = json.usage as
    | { total_output_tokens?: number; total_input_tokens?: number }
    | undefined;
  if (usage?.total_output_tokens != null) {
    return {
      outputTokens: usage.total_output_tokens,
      inputTokens: usage.total_input_tokens,
    };
  }
  const meta = json.usageMetadata as
    | { candidatesTokenCount?: number; promptTokenCount?: number }
    | undefined;
  if (meta?.candidatesTokenCount != null) {
    return {
      outputTokens: meta.candidatesTokenCount,
      inputTokens: meta.promptTokenCount,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function generateOpenAI(
  opts: GenerateImagesOpts,
  index: number
): Promise<GeneratedImage> {
  const client = new OpenAI({ apiKey: opts.apiKey });
  const { style, character } = cappedRefs(opts);
  const refs = [...style, ...character];
  const prompt = promptForVariant(opts.prompt, index);
  // gpt-image-2 accepts any size whose edges are multiples of 16. 16:9
  // lands exactly on the YouTube size; the 9:16 frame is nudged from
  // 1080 to 1088 wide, and the overlay's cover-fit crops the difference.
  const dims = frameSizeMultipleOf16(opts.aspect ?? DEFAULT_ASPECT);
  const size = `${dims.width}x${dims.height}` as `${number}x${number}`;

  const result = refs.length
    ? await client.images.edit({
        model: opts.model,
        prompt,
        size,
        image: await Promise.all(
          refs.map((r, i) =>
            toFile(r.bytes, `ref-${i}.png`, { type: r.mimeType })
          )
        ),
      })
    : await client.images.generate({ model: opts.model, prompt, size });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) {
    throw new ImageProviderError("OpenAI returned no image data", "openai");
  }
  return {
    bytes: Buffer.from(b64, "base64"),
    mimeType: "image/png",
    usage: result.usage
      ? {
          outputTokens: result.usage.output_tokens,
          inputTokens: result.usage.input_tokens,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// fal.ai
// ---------------------------------------------------------------------------

async function generateFal(
  opts: GenerateImagesOpts,
  index: number
): Promise<GeneratedImage> {
  const { style, character } = cappedRefs(opts);
  const refs = [...style, ...character];

  const body: Record<string, unknown> = {
    prompt: promptForVariant(opts.prompt, index),
    image_size: frameSize(opts.aspect ?? DEFAULT_ASPECT),
    num_images: 1,
  };
  // fal takes references as URLs, and data: URIs count — which saves us
  // uploading to their storage API just to hand the bytes straight back.
  if (refs.length) {
    body.image_urls = refs.map(
      (r) => `data:${r.mimeType};base64,${r.bytes.toString("base64")}`
    );
  }

  const res = await fetch(`https://fal.run/${opts.model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new ImageProviderError(
      `fal request failed (${res.status}): ${truncate(await res.text())}`,
      "fal",
      res.status
    );
  }

  const json = (await res.json()) as {
    images?: Array<{ url?: string; content_type?: string }>;
  };
  const first = json.images?.[0];
  if (!first?.url) {
    throw new ImageProviderError("fal returned no image", "fal");
  }

  // The URL is a short-lived CDN link — fetch it now so the caller
  // always ends up with bytes it can write to disk.
  const imgRes = await fetch(first.url);
  if (!imgRes.ok) {
    throw new ImageProviderError(
      `could not download the image fal produced (${imgRes.status})`,
      "fal",
      imgRes.status
    );
  }
  const falBytes = Buffer.from(await imgRes.arrayBuffer());
  return {
    bytes: falBytes,
    mimeType: sniffImageMime(falBytes, first.content_type ?? null),
    // fal bills per image and reports no token usage.
    usage: { images: 1 },
  };
}

// ---------------------------------------------------------------------------
// kie.ai
// ---------------------------------------------------------------------------

const KIE_BASE = "https://api.kie.ai/api/v1/jobs";
const KIE_POLL_INTERVAL_MS = 2000;
const KIE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * kie.ai resells other providers' models behind one key and one async
 * protocol: createTask returns a taskId, then you poll recordInfo until
 * the state settles. We poll rather than use their callback because this
 * app runs on someone's laptop with no public URL for a webhook to reach.
 *
 * Reference images go in as URLs, not bytes — which our winners already
 * are, since they're public YouTube thumbnails.
 *
 * The request BODY is per-model, not one shape for all of them. kie
 * proxies each vendor's own schema unchanged: Nano Banana takes reference
 * URLs in `image_input`, Seedream in `image_urls`, FLUX 2 in
 * `input_urls`, and the text-to-image endpoints take none; `output_format`
 * exists on only some of them. So the body is assembled from
 * `kieRequestShape()` — see KIE_REQUEST_SHAPES in image-provider-types.ts
 * for where those values come from. A hardcoded shape would either be
 * rejected outright or, worse, quietly drop the user's reference
 * thumbnails on every non-Gemini model.
 */
export function buildKieInput(
  model: string,
  prompt: string,
  aspect: AspectChoice,
  refUrls: string[]
): Record<string, unknown> {
  const shape = kieRequestShape(model);
  return {
    prompt,
    aspect_ratio: aspect,
    ...(shape.outputFormat ? { output_format: "png" } : {}),
    ...(shape.refsField && refUrls.length
      ? { [shape.refsField]: refUrls }
      : {}),
  };
}

async function generateKie(
  opts: GenerateImagesOpts,
  index: number
): Promise<GeneratedImage> {
  const { style, character } = cappedRefs(opts);
  const refUrls = [...style, ...character]
    .map((r) => r.sourceUrl)
    .filter((u): u is string => !!u);

  const createRes = await fetch(`${KIE_BASE}/createTask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model,
      input: buildKieInput(
        opts.model,
        promptForVariant(opts.prompt, index),
        opts.aspect ?? DEFAULT_ASPECT,
        refUrls
      ),
    }),
  });

  if (!createRes.ok) {
    throw new ImageProviderError(
      `kie.ai task creation failed (${createRes.status}): ${truncate(
        await createRes.text()
      )}`,
      "kie",
      createRes.status
    );
  }

  const created = (await createRes.json()) as {
    code?: number;
    msg?: string;
    data?: { taskId?: string };
  };
  const taskId = created.data?.taskId;
  if (!taskId) {
    // kie answers HTTP 200 with a non-200 `code` for things like an
    // exhausted free tier, so the body has to be checked too.
    throw new ImageProviderError(
      `kie.ai returned no task id (code ${created.code ?? "?"}): ${
        created.msg ?? "no message"
      }`,
      "kie"
    );
  }

  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > KIE_TIMEOUT_MS) {
      throw new ImageProviderError(
        `kie.ai task ${taskId} did not finish within ${
          KIE_TIMEOUT_MS / 1000
        }s`,
        "kie"
      );
    }
    await new Promise((r) => setTimeout(r, KIE_POLL_INTERVAL_MS));

    const pollRes = await fetch(
      `${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${opts.apiKey}` } }
    );
    if (!pollRes.ok) {
      throw new ImageProviderError(
        `kie.ai status check failed (${pollRes.status}): ${truncate(
          await pollRes.text()
        )}`,
        "kie",
        pollRes.status
      );
    }

    const poll = (await pollRes.json()) as {
      data?: {
        state?: string;
        resultJson?: string;
        failMsg?: string;
        failCode?: string;
        creditsConsumed?: number;
      };
    };
    const state = poll.data?.state;

    if (state === "fail") {
      throw new ImageProviderError(
        `kie.ai task failed (${poll.data?.failCode ?? "?"}): ${
          poll.data?.failMsg ?? "no message"
        }`,
        "kie"
      );
    }
    if (state !== "success") continue;

    // resultJson arrives as a JSON *string*, not an object.
    let urls: string[] = [];
    try {
      const parsed = JSON.parse(poll.data?.resultJson ?? "{}") as {
        resultUrls?: string[];
      };
      urls = parsed.resultUrls ?? [];
    } catch {
      throw new ImageProviderError(
        "kie.ai returned a result we could not parse",
        "kie"
      );
    }
    if (!urls[0]) {
      throw new ImageProviderError("kie.ai returned no image URL", "kie");
    }

    const imgRes = await fetch(urls[0]);
    if (!imgRes.ok) {
      throw new ImageProviderError(
        `could not download the image kie.ai produced (${imgRes.status})`,
        "kie",
        imgRes.status
      );
    }
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    return {
      bytes,
      // kie serves whatever the underlying model produced — Nano Banana
      // Pro returns JPEG even when the request asks for png — so the type
      // is read off the bytes rather than assumed. Claiming png for a
      // JPEG would write a file whose name lies about its contents.
      mimeType: sniffImageMime(bytes, imgRes.headers.get("content-type")),
      usage: {
        images: 1,
        credits: poll.data?.creditsConsumed,
      },
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * The image type, taken from the bytes themselves and only falling back
 * to what the server claimed. Providers are casual about this: a request
 * for png can come back as JPEG with a png content-type, and the caller
 * names the file from whatever we return here.
 */
function sniffImageMime(bytes: Buffer, headerValue: string | null): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  const header = headerValue?.split(";")[0]?.trim();
  return header && header.startsWith("image/") ? header : "image/png";
}

/**
 * Provider error bodies can be enormous and occasionally echo the request
 * back — including base64 reference images. Cap what reaches a log line
 * or a UI toast.
 */
function truncate(s: string, max = 300): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
