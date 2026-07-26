"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Plus, Trash2, Wand2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThumbnailUsage } from "@/components/thumbnail-usage";
import { cn } from "@/lib/utils";
import {
  IMAGE_MODELS,
  IMAGE_PROVIDER_CHOICES,
  defaultModelFor,
  imageProviderKeyUrl,
  imageProviderLabel,
  type ImageProviderChoice,
} from "@/lib/image-provider-types";

/**
 * Image-generation providers on the Settings page.
 *
 * Deliberately a list rather than the fixed named slots the other
 * integrations use: the user can hold several keys — two Gemini
 * projects, an OpenAI key to compare against — and flip the active one
 * between generations without retyping anything. Exactly one is active,
 * and the Thumbnails tab shows which.
 *
 * Keys arrive masked from the server and are never rendered in full.
 * Leaving the key field blank on an edit keeps the stored key.
 */

type ProviderView = {
  id: number;
  provider: ImageProviderChoice;
  providerLabel: string;
  label: string;
  masked: string;
  model: string;
  modelLabel: string;
  isActive: boolean;
};

export function ImageProviderSettings() {
  const [rows, setRows] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<ImageProviderChoice>("gemini");
  const [model, setModel] = useState(defaultModelFor("gemini"));
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/image-providers", { cache: "no-store" });
    if (r.ok) {
      const j = (await r.json()) as { providers: ProviderView[] };
      setRows(j.providers);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/image-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, label, apiKey }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setError(j.error ?? "Could not save the provider.");
        return;
      }
      setApiKey("");
      setLabel("");
      setAdding(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: number, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch(`/api/image-providers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    setBusy(true);
    try {
      await fetch(`/api/image-providers/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Wand2 className="h-4 w-4" /> Thumbnail image generation
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Used by Ideation → Thumbnails. Add as many keys as you like and
              switch the active one; only the active provider is ever called.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdding((v) => !v)}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        </div>

        {error && <div className="text-xs text-destructive">{error}</div>}

        {adding && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap gap-2">
              <select
                value={provider}
                onChange={(e) => {
                  const next = e.target.value as ImageProviderChoice;
                  setProvider(next);
                  setModel(defaultModelFor(next));
                }}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                {IMAGE_PROVIDER_CHOICES.map((p) => (
                  <option key={p} value={p}>
                    {imageProviderLabel(p)}
                  </option>
                ))}
              </select>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              >
                {IMAGE_MODELS[provider].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.estimateCents !== null
                      ? ` — ~$${(m.estimateCents / 100).toFixed(2)}/image`
                      : " — price not published"}
                  </option>
                ))}
              </select>
            </div>

            {IMAGE_MODELS[provider].find((m) => m.id === model)?.note && (
              <p className="text-xs text-muted-foreground">
                {IMAGE_MODELS[provider].find((m) => m.id === model)?.note}
              </p>
            )}

            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`Name this entry (default: ${imageProviderLabel(provider)})`}
            />
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder="API key"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={add} disabled={busy || !apiKey.trim()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
              <a
                href={imageProviderKeyUrl(provider)}
                target="_blank"
                rel="noreferrer"
                className="text-xs underline text-muted-foreground"
              >
                where to get a key
              </a>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No image provider configured yet — the Thumbnails tab can analyse
            style without one, but cannot generate.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <div
                key={row.id}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm",
                  row.isActive ? "border-primary" : "border-border"
                )}
              >
                <span className="font-medium">{row.label}</span>
                <span className="text-xs text-muted-foreground">
                  {row.providerLabel}
                </span>
                <select
                  value={row.model}
                  onChange={(e) => patch(row.id, { model: e.target.value })}
                  className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs"
                >
                  {IMAGE_MODELS[row.provider].map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <span className="font-mono text-xs text-muted-foreground">
                  {row.masked}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  {row.isActive ? (
                    <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs text-foreground">
                      <Check className="h-3 w-3" /> active
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={busy}
                      onClick={() => patch(row.id, { activate: true })}
                    >
                      Use this
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(row.id)}
                    disabled={busy}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Delete provider"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <ThumbnailUsage />
      </CardContent>
    </Card>
  );
}
