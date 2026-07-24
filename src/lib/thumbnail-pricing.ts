import "server-only";
import type { ImageProviderChoice } from "./image-provider-types";
import type { ImageUsage } from "./image-provider";

/**
 * Turns provider usage numbers into a recorded cost.
 *
 * This is deliberately separate from the estimate table in
 * `image-provider-types.ts`. That one exists to put a number on the
 * button BEFORE the user spends anything. This one runs after, using
 * what the provider actually reported.
 *
 * The rule when we don't have a verified rate for a model: return null.
 * The run is then stored with `cost_cents = NULL` and the UI says how
 * many runs have no cost data, rather than quietly reporting the
 * estimate as if it were measured.
 *
 * Rates below were read off each provider's own pricing page on
 * 2026-07-24. Anything not listed is intentionally absent, not
 * forgotten.
 */

/** USD per 1M output tokens, for providers that bill images as tokens. */
const TOKEN_RATES: Record<string, { outputPerM: number; inputPerM?: number }> = {
  // https://ai.google.dev/gemini-api/docs/pricing
  "gemini-3-pro-image": { outputPerM: 120 },
  "gemini-3.1-flash-image": { outputPerM: 60 },
  // https://developers.openai.com/api/docs/pricing
  "gpt-image-2": { outputPerM: 30, inputPerM: 8 },
  "gpt-image-1.5": { outputPerM: 32, inputPerM: 8 },
  "gpt-image-1-mini": { outputPerM: 8, inputPerM: 2.5 },
};

/** USD per generated image, for providers that bill per output. */
const PER_IMAGE_RATES: Record<string, number> = {
  // https://pricepertoken.com/image — fal publishes per-model unit prices
  "fal-ai/bytedance/seedream/v4-5/text-to-image": 0.035,
};

/**
 * Cost of one run in cents, or null when we can't compute it honestly.
 *
 * `usages` is one entry per generated image; entries the provider left
 * empty are skipped rather than guessed at, so a run where two of four
 * images reported usage yields the cost of those two and the caller can
 * see the count doesn't match.
 */
export function measuredRunCostCents(
  provider: ImageProviderChoice,
  model: string,
  usages: Array<ImageUsage | undefined>
): number | null {
  const tokenRate = TOKEN_RATES[model];
  const perImage = PER_IMAGE_RATES[model];
  if (!tokenRate && perImage === undefined) return null;

  let usd = 0;
  let counted = 0;

  for (const usage of usages) {
    if (!usage) continue;
    if (tokenRate && usage.outputTokens != null) {
      usd += (usage.outputTokens / 1_000_000) * tokenRate.outputPerM;
      if (tokenRate.inputPerM != null && usage.inputTokens != null) {
        usd += (usage.inputTokens / 1_000_000) * tokenRate.inputPerM;
      }
      counted++;
    } else if (perImage !== undefined && usage.images != null) {
      usd += perImage * usage.images;
      counted++;
    }
  }

  if (counted === 0) return null;
  void provider;
  return usd * 100;
}

/** Formats cents for the UI without pretending to sub-cent precision. */
export function formatCents(cents: number): string {
  if (cents < 1) return `<$0.01`;
  return `$${(cents / 100).toFixed(2)}`;
}
