import "server-only";
import {
  getActiveImageProvider,
  getIntegration,
  getThumbnailStyleProfile,
  type ImageProviderRow,
} from "./db";
import type { ThumbnailStyleProfile } from "./thumbnail-style";
import { isDryRun } from "./thumbnail-dryrun";

/** Stand-in row so a dry run doesn't need a stored provider. */
const DRY_RUN_PROVIDER: ImageProviderRow = {
  id: -1,
  provider: "gemini",
  label: "Dry run",
  api_key: "dry-run",
  model: "dry-run",
  is_active: 1,
  created_at: 0,
  updated_at: 0,
};

/**
 * Everything a generation needs before it is allowed to start, checked
 * in the order the user can act on.
 *
 * Shared by the single-title and batch routes so the same missing key
 * produces the same message wherever it is hit — a user who gets
 * "configure Claude" from one button and a stack trace from another
 * learns to distrust both.
 */

export type Preflight =
  | {
      ok: true;
      claudeKey: string;
      providerRow: ImageProviderRow;
      profile: ThumbnailStyleProfile;
    }
  | { ok: false; error: string; status: number };

export function preflight(channelId: string): Preflight {
  // In dry-run mode nothing is called, so demanding keys would only stop
  // the plumbing from being exercised. Every other check still applies —
  // a dry run with no style profile should fail exactly like a real one.
  const dry = isDryRun();

  const claudeKey = getIntegration("claude")?.api_key ?? (dry ? "dry-run" : null);
  if (!claudeKey) {
    return {
      ok: false,
      status: 400,
      error: "Claude API key is not configured. Add it in Integrations.",
    };
  }

  const providerRow = getActiveImageProvider() ?? (dry ? DRY_RUN_PROVIDER : null);
  if (!providerRow) {
    return {
      ok: false,
      status: 400,
      error:
        "No image provider is configured. Add one in Integrations and make it active.",
    };
  }

  const profileRow = getThumbnailStyleProfile(channelId);
  if (!profileRow) {
    return {
      ok: false,
      status: 400,
      error:
        "Analyse this channel's thumbnail style first — generation without it would be guesswork.",
    };
  }

  let profile: ThumbnailStyleProfile;
  try {
    profile = JSON.parse(profileRow.profile_json) as ThumbnailStyleProfile;
  } catch {
    return {
      ok: false,
      status: 400,
      error: "The stored style profile is unreadable — re-run the analysis.",
    };
  }

  return { ok: true, claudeKey, providerRow, profile };
}
