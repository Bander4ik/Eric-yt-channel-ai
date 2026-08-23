import { NextResponse } from "next/server";
import { getActiveChannelId } from "@/lib/db";
import { getDiscoveryPayload, hideDiscoveryChannel } from "@/lib/nexlev";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const ownerChannelId = getActiveChannelId();
  if (!ownerChannelId) {
    return NextResponse.json({ error: "Select your own YouTube channel first." }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { channelId?: unknown };
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!channelId) return NextResponse.json({ error: "channelId required" }, { status: 400 });
  hideDiscoveryChannel(ownerChannelId, channelId);
  return NextResponse.json({ ok: true, data: getDiscoveryPayload(ownerChannelId) });
}
