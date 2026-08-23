import { NextResponse } from "next/server";
import { getActiveChannelId } from "@/lib/db";
import {
  discoverOpportunities,
  getDiscoveryPayload,
  nexlevApiKey,
  nexlevConfigured,
  NexLevError,
} from "@/lib/nexlev";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET() {
  const channelId = getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "Select your own YouTube channel first." }, { status: 400 });
  }
  return NextResponse.json({
    configured: nexlevConfigured(),
    channelId,
    data: getDiscoveryPayload(channelId),
  });
}

export async function POST() {
  const channelId = getActiveChannelId();
  if (!channelId) {
    return NextResponse.json({ error: "Select your own YouTube channel first." }, { status: 400 });
  }
  const apiKey = nexlevApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Add a NexLev API key in Settings before finding opportunities." },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json({ configured: true, channelId, data: await discoverOpportunities(channelId, apiKey) });
  } catch (error) {
    const status = error instanceof NexLevError ? error.status ?? 502 : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "NexLev discovery failed." },
      { status }
    );
  }
}
