import { NextResponse } from "next/server";
import { getIntegration } from "@/lib/db";
import { resolveChannel, YouTubeApiError } from "@/lib/youtube";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { input?: string };
  if (!body.input?.trim()) {
    return NextResponse.json({ error: "input required" }, { status: 400 });
  }
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    return NextResponse.json(
      { error: "YouTube API key is not configured. Add it in Settings." },
      { status: 400 }
    );
  }
  try {
    const channel = await resolveChannel(body.input, apiKey);
    return NextResponse.json({ channel });
  } catch (err) {
    if (err instanceof YouTubeApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
