import { NextResponse } from "next/server";
import { hookOverallStats } from "@/lib/db";
import { generatePlaybook, getStoredPlaybook } from "@/lib/hook-playbook";
import { PROVIDER_CHOICES, type ProviderChoice } from "@/lib/ai-provider-types";

export const runtime = "nodejs";
// One consolidation call over ~40 videos' feedback with an 8k output
// budget takes well past the default limit.
export const maxDuration = 300;

/**
 * GET /api/hooks/playbook
 *
 * The stored playbook for the active channel (or null), plus the CURRENT
 * analysed-hook count. The UI diffs that against `hooksAnalyzed` at
 * generation time to tell the user "3 new hooks analysed since this was
 * generated" — otherwise a stale playbook looks indistinguishable from a
 * fresh one.
 */
export async function GET() {
  const stored = getStoredPlaybook();
  const overall = hookOverallStats();
  return NextResponse.json({
    playbook: stored.stored,
    model: stored.model,
    generatedAt: stored.generatedAt,
    hooksAnalyzedAtGeneration: stored.hooksAnalyzedAtGeneration,
    hooksAnalyzed: overall.analyzed,
  });
}

/**
 * POST /api/hooks/playbook
 *
 * Body (optional): { provider?: ProviderChoice } — same contract as the
 * analyze routes, so the Hook Lab model picker applies here too.
 */
export async function POST(req: Request) {
  let provider: ProviderChoice | undefined;
  try {
    const text = await req.text();
    if (text.trim()) {
      const body = JSON.parse(text) as { provider?: string };
      if (
        typeof body.provider === "string" &&
        PROVIDER_CHOICES.includes(body.provider as ProviderChoice)
      ) {
        provider = body.provider as ProviderChoice;
      }
    }
  } catch {
    /* empty body is fine — the generator falls back to its default provider */
  }

  const result = await generatePlaybook(provider);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    playbook: { playbook: result.playbook, facts: result.facts },
    model: result.model,
    hooksAnalyzedAtGeneration: result.hooksAnalyzed,
    hooksAnalyzed: result.hooksAnalyzed,
    generatedAt: Math.floor(Date.now() / 1000),
  });
}
