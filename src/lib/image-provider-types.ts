/**
 * Image-generation provider constants shared by server and client.
 *
 * Deliberately NOT marked `server-only` — the Integrations page and the
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
      estimateCents: 13.4,
      maxStyleRefs: 3,
      maxCharacterRefs: 5,
      note: "Best text-in-frame. Hard cap of 3 style references.",
    },
    {
      id: "gemini-3.1-flash-image",
      label: "Gemini 3.1 Flash Image",
      estimateCents: 6.7,
      maxStyleRefs: 4,
      maxCharacterRefs: 4,
      note: "Half the price, still strong. Good for iterating.",
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
  // public YouTube URLs so those work, but locally uploaded brand assets
  // cannot be sent — hence maxCharacterRefs: 0.
  kie: [
    {
      id: "nano-banana-pro",
      label: "Nano Banana Pro (Gemini 3 Pro Image)",
      estimateCents: null,
      maxStyleRefs: 3,
      maxCharacterRefs: 0,
      note: "Takes reference images. kie bills in credits and publishes no per-image price for this model, so no cost is recorded — check your kie dashboard.",
    },
    {
      id: "google/nano-banana",
      label: "Nano Banana (Gemini 2.5 Flash Image)",
      estimateCents: 2,
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

/** YouTube's own thumbnail spec. Everything is produced at this size. */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

export const MAX_VARIANTS = 8;
export const DEFAULT_VARIANTS = 4;
