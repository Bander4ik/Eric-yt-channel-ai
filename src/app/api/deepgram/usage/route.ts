import { NextResponse } from "next/server";
import { deepgramStats, getSetting, setSetting } from "@/lib/db";

export const runtime = "nodejs";

/** Default assumed credit for a fresh Deepgram account ($200 trial). */
const DEFAULT_CREDIT_USD = 200;

/**
 * Usage stats for the Settings page.
 *   total — spent so far (authoritative, from our ledger)
 *   limit — credit the user says they have (editable; default $200)
 *   remaining = limit − total
 */
export async function GET() {
  const stats = deepgramStats();
  const limitRaw = getSetting("deepgram.creditLimitUsd");
  const limitUsd = limitRaw ? Number(limitRaw) : DEFAULT_CREDIT_USD;
  const limitCents = Math.round(limitUsd * 100);
  const remainingCents = Math.max(0, limitCents - stats.totalCostCents);
  return NextResponse.json({
    totalCostCents: stats.totalCostCents,
    totalSeconds: stats.totalSeconds,
    transcriptCount: stats.transcriptCount,
    lastUsageAt: stats.lastUsageAt,
    last10: stats.last10,
    limitCents,
    remainingCents,
    percentUsed: limitCents > 0 ? Math.min(100, (stats.totalCostCents / limitCents) * 100) : 0,
  });
}

/**
 * POST — update the user's credit limit. Useful if they're on a paid plan
 * with a different balance or bought extra credits.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { limitUsd?: number };
  const limitUsd = Number(body.limitUsd);
  if (!Number.isFinite(limitUsd) || limitUsd < 0) {
    return NextResponse.json({ error: "limitUsd must be a non-negative number" }, { status: 400 });
  }
  setSetting("deepgram.creditLimitUsd", String(limitUsd));
  return NextResponse.json({ ok: true, limitUsd });
}
