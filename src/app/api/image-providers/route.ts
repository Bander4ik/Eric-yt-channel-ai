import { NextResponse } from "next/server";
import {
  createImageProvider,
  getActiveImageProvider,
  listImageProviders,
} from "@/lib/db";
import {
  defaultModelFor,
  imageProviderLabel,
  isImageProviderChoice,
} from "@/lib/image-provider-types";
import { toImageProviderView } from "@/lib/image-provider-view";

/**
 * Image-generation providers: list and create.
 *
 * Unlike /api/integrations this is a list, not a fixed set of named
 * slots — the user can hold several keys (two Gemini projects, an
 * OpenAI key for comparison) and switch the active one per run.
 *
 * Keys are masked on the way out using the same shape as
 * /api/integrations. The full key never leaves the server.
 */

export const runtime = "nodejs";

export async function GET() {
  const rows = listImageProviders();
  const active = getActiveImageProvider();
  return NextResponse.json({
    providers: rows.map(toImageProviderView),
    activeId: active?.id ?? null,
  });
}

export async function POST(req: Request) {
  let body: { provider?: unknown; label?: unknown; apiKey?: unknown; model?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!isImageProviderChoice(body.provider)) {
    return NextResponse.json(
      { error: "unknown image provider" },
      { status: 400 }
    );
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "an API key is required" }, { status: 400 });
  }

  const model =
    typeof body.model === "string" && body.model
      ? body.model
      : defaultModelFor(body.provider);

  try {
    const row = createImageProvider({
      provider: body.provider,
      label:
        typeof body.label === "string" && body.label.trim()
          ? body.label.trim()
          : imageProviderLabel(body.provider),
      apiKey,
      model,
    });
    return NextResponse.json({ provider: toImageProviderView(row) });
  } catch (err) {
    // Same failure modes as the integrations write: read-only project
    // folder, full disk, or a better-sqlite3 binary that didn't build.
    // Report the real reason instead of pretending the key was saved.
    const message =
      err instanceof Error ? err.message : "unknown database error";
    return NextResponse.json(
      { error: `could not save to the local database — ${message}` },
      { status: 500 }
    );
  }
}
