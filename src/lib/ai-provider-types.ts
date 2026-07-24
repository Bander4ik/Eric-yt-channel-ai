/**
 * Client-safe slice of the AI provider abstraction. The full file
 * (`ai-provider.ts`) is `server-only` because it imports the Anthropic
 * and Gemini SDKs and runs network calls — the chat UI just needs to
 * know the provider choice + display labels, so we keep those here.
 *
 * Both files re-export the same constants so callsites can import
 * either without thinking; the bundler picks the lighter `-types`
 * entry for client components automatically.
 *
 * Adding a new model: append to ProviderChoice + PROVIDER_CHOICES,
 * cover it in providerLabel(), and make sure providerModelId() returns
 * the exact id Google AI Studio expects. Cheapest → most expensive
 * order in PROVIDER_CHOICES is what shows up in the dropdown.
 */

export type ProviderChoice =
  | "claude"
  | "gemini-2.5-flash-lite"
  | "gemini-2.5-flash"
  | "gemini-2.5-pro"
  | "gemini-3-flash"
  | "gemini-3-pro"
  | "gemini-3.1-flash-lite"
  | "gemini-3.1-flash"
  | "gemini-3.1-pro";

export const PROVIDER_CHOICES: ProviderChoice[] = [
  "claude",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3-flash",
  "gemini-3-pro",
  "gemini-3.1-flash",
  "gemini-3.1-pro",
];

export const DEFAULT_PROVIDER: ProviderChoice = "claude";

/**
 * What a Gemini user gets when they don't pick a model themselves.
 *
 * Kept next to DEFAULT_PROVIDER because the two answer the same
 * question from either side of the key the user happens to hold: an
 * Anthropic key means Sonnet 5, a Google key means Gemini 3.1
 * Flash-Lite. Anything that resolves a model from "which key is
 * configured" should read these two constants rather than hardcoding an
 * id, so the defaults move in one place.
 */
export const DEFAULT_GEMINI_PROVIDER: ProviderChoice = "gemini-3.1-flash-lite";

/**
 * Display label for the model picker. We keep "(latest)" / "(legacy)"
 * tags off the labels because Google ships new generations every couple
 * of months — re-labelling forever is busywork. Users learn fast that
 * higher numbers are newer.
 */
export function providerLabel(p: ProviderChoice): string {
  switch (p) {
    case "claude":
      return "Claude Sonnet 5";
    case "gemini-2.5-flash-lite":
      return "Gemini 2.5 Flash-Lite";
    case "gemini-2.5-flash":
      return "Gemini 2.5 Flash";
    case "gemini-2.5-pro":
      return "Gemini 2.5 Pro";
    case "gemini-3-flash":
      return "Gemini 3 Flash";
    case "gemini-3-pro":
      return "Gemini 3 Pro";
    case "gemini-3.1-flash-lite":
      return "Gemini 3.1 Flash-Lite";
    case "gemini-3.1-flash":
      return "Gemini 3.1 Flash";
    case "gemini-3.1-pro":
      return "Gemini 3.1 Pro";
  }
}

/** Which integration row in the DB holds the API key for this provider. */
export function providerIntegrationName(
  p: ProviderChoice
): "claude" | "google_gemini" {
  return p === "claude" ? "claude" : "google_gemini";
}

/**
 * Underlying model id sent to the SDK. Gemini choices double as the
 * raw Google AI Studio model id — if Google ever pulls or renames a
 * model, the SDK error surfaces directly to the user, no mapping
 * table to drift out of sync.
 */
export function providerModelId(p: ProviderChoice): string {
  if (p === "claude") return "claude-sonnet-5";
  return p; // every gemini-* enum value matches the SDK's model id verbatim
}
