import { NextResponse } from "next/server";
import { getIntegration } from "@/lib/db";
import { getApifyUsage } from "@/lib/apify-usage";

export const runtime = "nodejs";

/**
 * GET /api/integrations/apify/usage
 *
 * Returns the Apify monthly credit/usage snapshot used by the
 * Settings card progress bar. Falls back to `configured: false`
 * if there's no API key on file, or `usage: null` if Apify replied
 * but the response shape was unexpected — UI shows "Connected" in
 * that case without a meaningless bar.
 */
export async function GET() {
  const apiKey = getIntegration("apify")?.api_key;
  if (!apiKey) {
    return NextResponse.json({ configured: false, usage: null });
  }
  try {
    const usage = await getApifyUsage(apiKey);
    return NextResponse.json({ configured: true, usage });
  } catch (e) {
    return NextResponse.json({
      configured: true,
      usage: null,
      error: e instanceof Error ? e.message : "unknown error",
    });
  }
}
