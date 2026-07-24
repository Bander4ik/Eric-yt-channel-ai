import {
  findModelOption,
  imageProviderLabel,
  isImageProviderChoice,
  type ImageProviderChoice,
} from "./image-provider-types";

/**
 * The client-safe view of a stored image provider.
 *
 * Lives here rather than in the route file because Next only allows HTTP
 * handlers and route config to be exported from `route.ts`, and both the
 * collection route and the per-id route need this mapping.
 *
 * The raw API key never appears in this shape — only a mask, in the same
 * format the Integrations page already uses for its keys.
 */

export type ImageProviderView = {
  id: number;
  provider: ImageProviderChoice;
  providerLabel: string;
  label: string;
  masked: string;
  model: string;
  modelLabel: string;
  isActive: boolean;
};

export function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}••••••${key.slice(-4)}`;
}

export function toImageProviderView(row: {
  id: number;
  provider: string;
  label: string;
  api_key: string;
  model: string | null;
  is_active: number;
}): ImageProviderView {
  const provider: ImageProviderChoice = isImageProviderChoice(row.provider)
    ? row.provider
    : "gemini";
  const modelOption = findModelOption(provider, row.model);
  return {
    id: row.id,
    provider,
    providerLabel: imageProviderLabel(provider),
    label: row.label,
    masked: maskKey(row.api_key),
    model: modelOption.id,
    modelLabel: modelOption.label,
    isActive: row.is_active === 1,
  };
}
