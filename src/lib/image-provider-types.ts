/**
 * Image-generation provider constants shared by server and client.
 *
 * Deliberately NOT marked `server-only` — the Settings page and the
 * Thumbnails tab both need the model lists and the price estimates to
 * render, and duplicating them client-side is how the two drift apart.
 * The actual SDK calls live in `image-provider.ts`, which IS server-only.
 *
 * Prices below are ESTIMATES taken from each provider's published rates
 * on 2026-07-24. They exist to put a number on the button before the
 * user spends money — they are not what gets recorded. After a run,
 * `thumbnail_runs.cost_cents` holds the cost derived from the provider's
 * own usage response (see `thumbnail-pricing.ts`). Whenever the two
 * disagree, the recorded one is the truth and this table needs updating.
 */

export type ImageProviderChoice = "gemini" | "openai" | "fal" | "kie";

export const IMAGE_PROVIDER_CHOICES: ImageProviderChoice[] = [
  "gemini",
  "openai",
  "fal",
  "kie",
];

export function imageProviderLabel(p: ImageProviderChoice): string {
  if (p === "gemini") return "Google Gemini";
  if (p === "openai") return "OpenAI";
  if (p === "kie") return "kie.ai";
  return "fal.ai";
}

/** Where the user goes to get a key, shown next to the empty input. */
export function imageProviderKeyUrl(p: ImageProviderChoice): string {
  if (p === "gemini") return "https://aistudio.google.com/apikey";
  if (p === "openai") return "https://platform.openai.com/api-keys";
  if (p === "kie") return "https://kie.ai/api-key";
  return "https://fal.ai/dashboard/keys";
}

export type ImageModelOption = {
  id: string;
  label: string;
  /**
   * Published cost per generated image, in cents. Estimate only.
   *
   * `null` means we have no verified rate for this model. The UI then
   * says "cost unknown" instead of showing a number — a made-up estimate
   * on a spend button is worse than no estimate.
   */
  estimateCents: number | null;
  /**
   * How many reference IMAGES this model accepts as style guidance.
   * Gemini publishes hard per-role caps; the others are looser but we
   * still bound them so a 24-winner channel doesn't push a 20 MB
   * request. Evidence beyond this cap reaches the model as text.
   */
  maxStyleRefs: number;
  maxCharacterRefs: number;
  note?: string;
};

export const IMAGE_MODELS: Record<ImageProviderChoice, ImageModelOption[]> = {
  gemini: [
    {
      id: "gemini-3-pro-image",
      label: "Gemini 3 Pro Image",
      // Google's published rate works out to 13.4c per 1K/2K image, but
      // a real 2-image run on 2026-07-24 recorded 32c from the API's own
      // usage numbers. The estimate follows the measurement, not the
      // brochure: a button that promises less than it charges is worse
      // than one that rounds up.
      estimateCents: 16,
      maxStyleRefs: 3,
      maxCharacterRefs: 5,
      note: "Best text-in-frame. Hard cap of 3 style references.",
    },
    {
      id: "gemini-3.1-flash-image",
      label: "Gemini 3.1 Flash Image",
      // Published rate is 6.7c; a real 2-image run on 2026-07-24 recorded
      // 8.5c each. Estimate follows the measurement. Still roughly half
      // the Pro model's cost.
      estimateCents: 9,
      maxStyleRefs: 4,
      maxCharacterRefs: 4,
      note: "About half the price of Pro, still strong. Good for iterating and for high-volume runs.",
    },
    {
      id: "gemini-2.5-flash-image",
      label: "Gemini 2.5 Flash Image",
      estimateCents: 4,
      maxStyleRefs: 3,
      maxCharacterRefs: 3,
      note: "Older, cheapest Gemini tier.",
    },
  ],
  openai: [
    {
      id: "gpt-image-2",
      label: "GPT Image 2",
      // $30 / 1M output tokens; a 1536x1024-class image lands around
      // 1.5-2k output tokens, so ~6c. Verified against a real run's
      // usage before this number is presented as fact anywhere but the
      // estimate line.
      estimateCents: 6,
      maxStyleRefs: 4,
      maxCharacterRefs: 4,
    },
    {
      id: "gpt-image-1-mini",
      label: "GPT Image 1 mini",
      estimateCents: 2,
      maxStyleRefs: 4,
      maxCharacterRefs: 2,
      note: "Cheap draft tier.",
    },
  ],
  // kie.ai resells other people's models behind one key, which is why
  // it is the cheapest way in and also the most constrained: it takes
  // reference images as URLs only. Our own and competitor thumbnails are
  // public YouTube URLs so those work.
  //
  // A locally uploaded brand asset has no URL, and for a while that meant
  // maxCharacterRefs: 0 here and a client wondering why his character
  // never appeared. kie has its own file upload API, so we make a URL:
  // the asset goes to kie's temp storage under the user's own key
  // (see uploadToKie in image-provider.ts) and comes back as a link like
  // any other reference. Nothing is shared any wider than it already was
  // — the same file was always going to kie a moment later as generation
  // input; it just arrives one step earlier now.
  //
  // Still 0 on the text-to-image endpoints below: they accept no
  // reference images at all, so there is nowhere to put a character.
  //
  // The models split into two kinds. The image-to-image endpoints accept
  // reference URLs (each under its own field name — see
  // KIE_REQUEST_SHAPES below); the text-to-image ones accept none at all,
  // so their maxStyleRefs is 0 rather than a cap that would hand
  // references to a request with nowhere to put them.
  //
  // kie bills in its own credits and publishes no per-image price for any
  // of these, so estimateCents is null throughout. What the run actually
  // cost in credits is recorded from kie's own response.
  //
  // Grouped by family, with each reference-capable model ahead of its
  // text-only sibling. nano-banana-pro stays first overall because it is
  // the default for this provider.
  //
  // Models kie sells that are DELIBERATELY absent, so nobody helpfully
  // adds them later:
  //   - gpt-image/1.5-*      its aspect_ratio enum is only 1:1, 2:3, 3:2.
  //                          No 16:9 and no 9:16, so it cannot produce a
  //                          YouTube cover at all.
  //   - grok-imagine/image-to-image
  //                          takes a `size` field we have not mapped.
  //   - qwen/image-to-image  its schema has NEITHER aspect_ratio NOR
  //                          image_size — the output simply inherits the
  //                          reference image's shape. Since our references
  //                          are 16:9 thumbnails, a 9:16 Shorts request
  //                          would silently come back 16:9, and a model
  //                          that ignores the frame the user picked is
  //                          worse than no model at all.
  //   - *-edit and *-remix   (seedream edit, ideogram edit/remix, qwen
  //                          image-edit, nano-banana-edit) modify a
  //                          supplied image instead of generating a cover
  //                          — a different feature, not a model choice.
  //   - Topaz, Recraft       upscaling and background removal, not
  //                          generators.
  kie: [
    {
      id: "nano-banana-pro",
      label: "Nano Banana Pro (Gemini 3 Pro Image)",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 2,
      note: "Takes reference images. kie bills in credits and publishes no per-image price for this model, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "nano-banana-2",
      label: "Nano Banana 2 (Gemini 3.1 Flash Image)",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 2,
      note: "Takes reference images. kie bills in credits and publishes no per-image price, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "nano-banana-2-lite",
      label: "Nano Banana 2 Lite",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 2,
      note: "Takes reference images. kie bills in credits and publishes no per-image price, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "google/nano-banana",
      label: "Nano Banana (Gemini 2.5 Flash Image)",
      // The one kie model with a knowable price: it is 4 credits at kie's
      // published ~$0.005/credit. That is the same rate `thumbnail-pricing.ts`
      // records after a run, so leaving this null would show "price not
      // published" on the button and then charge a number we already knew.
      estimateCents: 2,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "seedream/5-pro-image-to-image",
      label: "Seedream 5 Pro",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 2,
      note: "Takes reference images. kie bills in credits and publishes no per-image price, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "seedream/5-pro-text-to-image",
      label: "Seedream 5 Pro (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "seedream/5-lite-image-to-image",
      label: "Seedream 5 Lite",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 2,
      note: "Takes reference images. kie bills in credits and publishes no per-image price, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "seedream/5-lite-text-to-image",
      label: "Seedream 5 Lite (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "seedream/4.5-text-to-image",
      label: "Seedream 4.5 (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "flux-2/pro-image-to-image",
      label: "FLUX 2 Pro",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 2,
      note: "Takes reference images. kie bills in credits and publishes no per-image price, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "flux-2/pro-text-to-image",
      label: "FLUX 2 Pro (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "flux-2/flex-image-to-image",
      label: "FLUX 2 Flex",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 2,
      note: "Takes reference images. kie bills in credits and publishes no per-image price, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "flux-2/flex-text-to-image",
      label: "FLUX 2 Flex (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "gpt-image-2-image-to-image",
      label: "GPT Image 2",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 2,
      note: "Takes reference images. kie bills in credits and publishes no per-image price, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "gpt-image-2-text-to-image",
      label: "GPT Image 2 (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "google/imagen4",
      label: "Imagen 4 (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "google/imagen4-fast",
      label: "Imagen 4 Fast (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "google/imagen4-ultra",
      label: "Imagen 4 Ultra (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "ideogram/v3-text-to-image",
      label: "Ideogram v3 (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "qwen/text-to-image",
      label: "Qwen Image (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "grok-imagine/text-to-image",
      label: "Grok Imagine (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
    {
      id: "z-image",
      label: "Z-Image (text only)",
      estimateCents: null,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only on this endpoint — no reference images, so covers follow the written style profile rather than your actual thumbnails.",
    },
  ],
  fal: [
    {
      id: "fal-ai/bytedance/seedream/v4-5/text-to-image",
      label: "Seedream 4.5",
      estimateCents: 3.5,
      maxStyleRefs: 4,
      maxCharacterRefs: 2,
    },
    {
      id: "fal-ai/flux-pro/v1.1",
      label: "FLUX Pro 1.1",
      estimateCents: 4,
      maxStyleRefs: 0,
      maxCharacterRefs: 0,
      note: "Text-to-image only — no image references on this endpoint.",
    },
  ],
};

/**
 * Per-model request shape for kie.ai.
 *
 * kie fronts a dozen other people's models behind one endpoint but does
 * NOT normalise their inputs: the field that carries reference image URLs
 * is named differently by each family, and most schemas have no
 * `output_format` at all. Sending the wrong field name gets the request
 * rejected; sending a field the model ignores means the user's actual
 * thumbnails silently fail to reach it.
 *
 * Values below were read from each model's own schema page under
 * https://docs.kie.ai/market/ on 2026-08-03. This table lives next to
 * IMAGE_MODELS on purpose — the two must never drift apart.
 */
export type KieRequestShape = {
  /** Which input field carries reference image URLs; null = text-to-image only. */
  refsField: string | null;
  /** false = the field takes ONE url as a plain string, not an array. */
  refsAsArray: boolean;
  /** Whether the model's schema documents an output_format field. */
  outputFormat: boolean;
  /**
   * How the frame is requested. Most families take `aspect_ratio: "16:9"`.
   * Ideogram and Qwen instead take `image_size` with named values —
   * `landscape_16_9` / `portrait_16_9` — and have no aspect_ratio at all.
   */
  aspectField: "aspect_ratio" | "image_size";
};

const RATIO = { refsAsArray: true, aspectField: "aspect_ratio" } as const;
const NAMED = { refsAsArray: true, aspectField: "image_size" } as const;

export const KIE_REQUEST_SHAPES: Record<string, KieRequestShape> = {
  // Nano Banana
  "nano-banana-pro": { ...RATIO, refsField: "image_input", outputFormat: true },
  "nano-banana-2": { ...RATIO, refsField: "image_input", outputFormat: true },
  "nano-banana-2-lite": { ...RATIO, refsField: "image_urls", outputFormat: false },
  "google/nano-banana": { ...RATIO, refsField: null, outputFormat: true },
  // Seedream
  "seedream/5-pro-image-to-image": { ...RATIO, refsField: "image_urls", outputFormat: true },
  "seedream/5-pro-text-to-image": { ...RATIO, refsField: null, outputFormat: true },
  "seedream/5-lite-image-to-image": { ...RATIO, refsField: "image_urls", outputFormat: true },
  "seedream/5-lite-text-to-image": { ...RATIO, refsField: null, outputFormat: true },
  "seedream/4.5-text-to-image": { ...RATIO, refsField: null, outputFormat: false },
  // FLUX
  "flux-2/pro-image-to-image": { ...RATIO, refsField: "input_urls", outputFormat: false },
  "flux-2/pro-text-to-image": { ...RATIO, refsField: null, outputFormat: false },
  "flux-2/flex-image-to-image": { ...RATIO, refsField: "input_urls", outputFormat: false },
  "flux-2/flex-text-to-image": { ...RATIO, refsField: null, outputFormat: false },
  // GPT Image
  "gpt-image-2-image-to-image": { ...RATIO, refsField: "input_urls", outputFormat: false },
  "gpt-image-2-text-to-image": { ...RATIO, refsField: null, outputFormat: false },
  // Imagen
  "google/imagen4": { ...RATIO, refsField: null, outputFormat: false },
  "google/imagen4-fast": { ...RATIO, refsField: null, outputFormat: false },
  "google/imagen4-ultra": { ...RATIO, refsField: null, outputFormat: false },
  // Ideogram — image_size, not aspect_ratio
  "ideogram/v3-text-to-image": { ...NAMED, refsField: null, outputFormat: false },
  // Qwen — image_size rather than aspect_ratio
  "qwen/text-to-image": { ...NAMED, refsField: null, outputFormat: true },
  // Grok
  "grok-imagine/text-to-image": { ...RATIO, refsField: null, outputFormat: false },
  // Z-Image
  "z-image": { ...RATIO, refsField: null, outputFormat: false },
};

/** kie's named frame values, for the models that use `image_size`. */
export function kieImageSize(a: AspectChoice): string {
  return a === "9:16" ? "portrait_16_9" : "landscape_16_9";
}

/**
 * Shape for a kie model id, defaulting to the safest possible request.
 *
 * An unknown id gets prompt + aspect_ratio and nothing else: fewer fields
 * degrade to a plain text-to-image generation, whereas a guessed field
 * name gets the whole request rejected.
 */
export function kieRequestShape(modelId: string): KieRequestShape {
  return (
    KIE_REQUEST_SHAPES[modelId] ?? {
      refsField: null,
      refsAsArray: true,
      outputFormat: false,
      aspectField: "aspect_ratio",
    }
  );
}

export function defaultModelFor(p: ImageProviderChoice): string {
  return IMAGE_MODELS[p][0].id;
}

export function findModelOption(
  p: ImageProviderChoice,
  modelId: string | null | undefined
): ImageModelOption {
  const list = IMAGE_MODELS[p];
  return list.find((m) => m.id === modelId) ?? list[0];
}

export function isImageProviderChoice(v: unknown): v is ImageProviderChoice {
  return (
    typeof v === "string" &&
    (IMAGE_PROVIDER_CHOICES as string[]).includes(v)
  );
}

/** YouTube's own thumbnail spec — the size a 16:9 cover is produced at. */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

/**
 * Output shape. A long-form cover and a Shorts cover are different design
 * problems, not the same picture cropped: the safe area, the headline
 * zone and the subject scale all change, so the aspect travels with the
 * run instead of being applied afterwards.
 */
export type AspectChoice = "16:9" | "9:16";

export const ASPECT_CHOICES: AspectChoice[] = ["16:9", "9:16"];
export const DEFAULT_ASPECT: AspectChoice = "16:9";

export function isAspectChoice(v: unknown): v is AspectChoice {
  return v === "16:9" || v === "9:16";
}

export function coerceAspect(v: unknown): AspectChoice {
  return isAspectChoice(v) ? v : DEFAULT_ASPECT;
}

export function aspectLabel(a: AspectChoice): string {
  return a === "9:16" ? "9:16 Shorts" : "16:9 video";
}

/**
 * Pixel size per aspect. 1080x1920 is what YouTube itself asks for on a
 * vertical cover; both edges are also multiples of 8, which keeps the
 * providers that quantise sizes happy.
 */
export function frameSize(a: AspectChoice): { width: number; height: number } {
  return a === "9:16"
    ? { width: 1080, height: 1920 }
    : { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT };
}

/**
 * Same frame, rounded to the multiple-of-16 edges OpenAI's image models
 * require. 1080 is not one; 1088 is, and the 8-pixel difference is
 * cropped away by the cover-fit in the overlay renderer.
 */
export function frameSizeMultipleOf16(a: AspectChoice): {
  width: number;
  height: number;
} {
  const { width, height } = frameSize(a);
  const round16 = (n: number) => Math.round(n / 16) * 16;
  return { width: round16(width), height: round16(height) };
}

export const MAX_VARIANTS = 8;
export const DEFAULT_VARIANTS = 4;
