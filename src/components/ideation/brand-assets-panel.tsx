"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Trash2, Upload } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { findModelOption, isImageProviderChoice } from "@/lib/image-provider-types";

/**
 * Per-channel brand assets.
 *
 * A faceless channel is recognised by a recurring element — a mascot, a
 * logo, a frame — far more than by its palette. Those get passed to the
 * image model as character references, which is the difference between
 * covers that look like this channel's GENRE and covers that look like
 * this channel.
 *
 * The font slot is the escape hatch for scripts the bundled font can't
 * render: upload one that covers them and the compositor uses it
 * instead, rather than handing the headline to the image model.
 */

type Asset = {
  id: number;
  channel_id: string;
  kind: string;
  label: string | null;
  file_path: string;
  created_at: number;
};

const KINDS = [
  { id: "character", label: "Character", hint: "A recurring mascot or figure" },
  { id: "logo", label: "Logo", hint: "Your channel mark" },
  { id: "frame", label: "Frame", hint: "A border or overlay you always use" },
  { id: "font", label: "Font", hint: ".ttf/.otf — used for the headline" },
] as const;

function fileUrl(rel: string): string {
  return `/api/thumbnails/file/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

export function BrandAssetsPanel({
  channelId,
  provider,
}: {
  channelId: string | null;
  /**
   * The image model that would actually be used. Needed because not every
   * one of them can receive an uploaded file — kie.ai takes reference
   * images by public URL only, so a locally uploaded character has nowhere
   * to go and is dropped. This panel promises the opposite in its own
   * subtitle, so it is the right place to take the promise back.
   */
  provider?: { provider: string; model: string | null } | null;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [kind, setKind] = useState<string>("character");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!channelId) return;
    const r = await fetch(
      `/api/brand-assets?channelId=${encodeURIComponent(channelId)}`,
      { cache: "no-store" }
    );
    if (!r.ok) return;
    const j = (await r.json()) as { assets: Asset[] };
    setAssets(j.assets);
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    if (!channelId) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("channelId", channelId);
      form.set("kind", kind);
      form.set("file", file);
      const r = await fetch("/api/brand-assets", { method: "POST", body: form });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) {
        setError(j.error ?? "Upload failed.");
        return;
      }
      await load();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (id: number) => {
    setBusy(true);
    try {
      await fetch(`/api/brand-assets/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const accept = kind === "font" ? ".ttf,.otf" : ".png,.jpg,.jpeg,.webp";

  // A font is never sent to the image model — it is used by our own
  // compositor — so only picture assets are affected by the model's limit.
  const pictureAssets = assets.filter((a) => a.kind !== "font");
  const dropped = useMemo(() => {
    if (!pictureAssets.length || !provider) return false;
    if (!isImageProviderChoice(provider.provider)) return false;
    return findModelOption(provider.provider, provider.model).maxCharacterRefs === 0;
  }, [pictureAssets.length, provider]);

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div>
          <div className="text-sm font-semibold">Brand assets</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Optional. Whatever appears on every one of your covers — a
            character, a logo, a frame — goes here and is sent to the image
            model as a reference so generated covers stay recognisably yours.
          </p>
        </div>

        {error && <div className="text-xs text-destructive">{error}</div>}

        {dropped && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong className="font-medium">
                Your brand assets are NOT being sent with the image model you
                have selected.
              </strong>{" "}
              This model generates from the written prompt alone and takes no
              reference images at all — not your character, and not your
              channel&apos;s thumbnails either. Pick a model whose note says it
              takes reference images, in Settings.
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            {KINDS.find((k) => k.id === kind)?.hint}
          </span>
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy || !channelId}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload
          </Button>
        </div>

        {assets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {assets.map((a) => (
              <div
                key={a.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border border-border p-1.5 text-xs"
                )}
              >
                {a.kind === "font" ? (
                  <span className="rounded bg-muted px-2 py-1 font-mono">Aa</span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={fileUrl(a.file_path)}
                    alt={a.label ?? a.kind}
                    className="h-10 w-10 rounded object-cover"
                  />
                )}
                <div className="max-w-[10rem]">
                  <div className="font-medium capitalize">{a.kind}</div>
                  <div className="truncate text-muted-foreground">
                    {a.label ?? ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  disabled={busy}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Delete asset"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
