import { NextResponse } from "next/server";
import {
  deleteImageProvider,
  getImageProvider,
  setActiveImageProvider,
  updateImageProvider,
} from "@/lib/db";
import { toImageProviderView } from "@/lib/image-provider-view";

/** Per-provider operations: rename / re-key / change model / activate / delete. */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const providerId = Number(id);
  if (!Number.isFinite(providerId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  if (!getImageProvider(providerId)) {
    return NextResponse.json({ error: "provider not found" }, { status: 404 });
  }

  let body: {
    label?: unknown;
    apiKey?: unknown;
    model?: unknown;
    activate?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (body.activate === true) {
    setActiveImageProvider(providerId);
  }

  // An empty apiKey means "leave the stored key alone" — the UI shows a
  // masked value, and submitting the form without retyping the key must
  // not wipe it.
  const patch: { label?: string; apiKey?: string; model?: string | null } = {};
  if (typeof body.label === "string" && body.label.trim()) {
    patch.label = body.label.trim();
  }
  if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    patch.apiKey = body.apiKey.trim();
  }
  if (typeof body.model === "string" && body.model) {
    patch.model = body.model;
  }
  if (Object.keys(patch).length > 0) {
    updateImageProvider(providerId, patch);
  }

  const row = getImageProvider(providerId);
  return NextResponse.json({
    provider: row ? toImageProviderView(row) : null,
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const providerId = Number(id);
  if (!Number.isFinite(providerId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const ok = deleteImageProvider(providerId);
  if (!ok) {
    return NextResponse.json({ error: "provider not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
