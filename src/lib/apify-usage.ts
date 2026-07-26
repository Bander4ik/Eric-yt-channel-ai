import "server-only";

/**
 * Apify billing snapshot used by both the Settings card and the
 * transcribe button on the video page. The Free plan ships $5 of
 * usage credit per calendar month — we surface a usable-bar against
 * that. Paid plans get treated the same; we just substitute their
 * monthly allowance.
 *
 * Two endpoints, two requests:
 *   GET /v2/users/me                → plan + monthly USD allowance
 *   GET /v2/users/me/usage/monthly  → current cycle usage in USD
 *
 * Both are public, both authed by Bearer token (the user's API token).
 * If either errors we degrade gracefully — the card shows "Connected"
 * without a bar rather than break.
 */

export type ApifyUsageSnapshot = {
  planName: string;
  monthlyAllowanceUsd: number | null;
  monthlyUsedUsd: number | null;
  remainingUsd: number | null;
  percentageUsed: number | null;
  // Rough estimate — Apify YouTube channel-scrape actor averages
  // ~$0.05 per channel-fetch at the time of writing (~50-100 videos
  // with their metadata + captions). Calibrate if it drifts.
  // Transcription itself is on Deepgram in this fork — this snapshot
  // exists for the competitor-scrape side of Apify use only.
  estimatedScrapesRemaining: number | null;
  cycleEndAt: string | null;
};

const SCRAPE_AVG_COST_USD = 0.05;

function safeNumber(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function getApifyUsage(apiKey: string): Promise<ApifyUsageSnapshot | null> {
  // ---- user/plan info ----
  const meRes = await fetch("https://api.apify.com/v2/users/me", {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!meRes.ok) return null;
  const meBody = (await meRes.json().catch(() => ({}))) as {
    data?: {
      plan?: {
        id?: string;
        description?: string;
        monthlyBasePriceUsd?: unknown;
        monthlyUsageCreditsUsd?: unknown;
        maxMonthlyUsageUsd?: unknown;
      };
      usageCycle?: {
        endAt?: string;
        currentPeriodEndAt?: string;
      };
    };
  };
  const plan = meBody.data?.plan ?? {};
  const planName = plan.description ?? plan.id ?? "Apify";
  // The "free plan" sets monthlyUsageCreditsUsd to 5 (USD). Paid plans
  // bump this to their allowance. maxMonthlyUsageUsd is the hard cap
  // (often >>credits on paid plans); credits is what we want for the
  // bar — that's the included allowance before overage.
  const monthlyAllowanceUsd =
    safeNumber(plan.monthlyUsageCreditsUsd) ??
    safeNumber(plan.maxMonthlyUsageUsd);

  // ---- current usage ----
  let monthlyUsedUsd: number | null = null;
  let cycleEndAt: string | null = null;
  try {
    const usageRes = await fetch(
      "https://api.apify.com/v2/users/me/usage/monthly",
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
      }
    );
    if (usageRes.ok) {
      const usageBody = (await usageRes.json().catch(() => ({}))) as {
        data?: {
          monthlyServiceUsage?: { totalAmount?: unknown };
          monthlyServiceUsageTotalAmount?: unknown;
          monthlyUsageUsd?: unknown;
          endAt?: string;
        };
      };
      const d = usageBody.data ?? {};
      monthlyUsedUsd =
        safeNumber(d.monthlyServiceUsage?.totalAmount) ??
        safeNumber(d.monthlyServiceUsageTotalAmount) ??
        safeNumber(d.monthlyUsageUsd);
      cycleEndAt = d.endAt ?? null;
    }
  } catch {
    /* leave monthlyUsedUsd null */
  }
  if (!cycleEndAt) {
    cycleEndAt =
      meBody.data?.usageCycle?.endAt ??
      meBody.data?.usageCycle?.currentPeriodEndAt ??
      null;
  }

  let percentageUsed: number | null = null;
  let remainingUsd: number | null = null;
  let estimatedScrapesRemaining: number | null = null;
  if (monthlyAllowanceUsd && monthlyAllowanceUsd > 0 && monthlyUsedUsd !== null) {
    percentageUsed = Math.min(
      100,
      Math.max(0, Math.round((monthlyUsedUsd / monthlyAllowanceUsd) * 100))
    );
    remainingUsd = Math.max(0, monthlyAllowanceUsd - monthlyUsedUsd);
    estimatedScrapesRemaining = Math.floor(
      remainingUsd / SCRAPE_AVG_COST_USD
    );
  } else if (monthlyAllowanceUsd && monthlyUsedUsd === null) {
    // Fallback: we know the allowance but not usage — assume nothing
    // spent yet so the bar shows full instead of empty. Better signal
    // than refusing to render.
    remainingUsd = monthlyAllowanceUsd;
    estimatedScrapesRemaining = Math.floor(
      monthlyAllowanceUsd / SCRAPE_AVG_COST_USD
    );
    percentageUsed = 0;
  }

  return {
    planName,
    monthlyAllowanceUsd,
    monthlyUsedUsd,
    remainingUsd,
    percentageUsed,
    estimatedScrapesRemaining,
    cycleEndAt,
  };
}
