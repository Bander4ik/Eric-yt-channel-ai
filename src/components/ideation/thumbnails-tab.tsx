"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  Image as ImageIcon,
  Info,
  Layers,
  Loader2,
  Plug,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
  Wand2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ASPECT_CHOICES,
  DEFAULT_ASPECT,
  DEFAULT_VARIANTS,
  findModelOption,
  MAX_VARIANTS,
  isImageProviderChoice,
  type AspectChoice,
} from "@/lib/image-provider-types";
import { TEXT_ZONES, type TextZone } from "@/lib/thumbnail-overlay-types";
import { BrandAssetsPanel } from "@/components/ideation/brand-assets-panel";
import { useUiPref } from "@/lib/ui-prefs";

/**
 * Thumbnails tab — generate covers in the style that measurably works
 * on this channel.
 *
 * Three things this screen refuses to hide, because they are the
 * difference between a useful tool and a slot machine:
 *   - what the generation is based on (named videos with multipliers);
 *   - what it will cost before the click, and what it did cost after;
 *   - when the evidence is too thin to be called a rule.
 */

type Winner = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  multiplier: number;
  views: number;
  sourceLabel: string;
};

type StyleTrait = { summary: string; n: number; evidence: string[] };

type StyleTraitSet = {
  composition: StyleTrait & { textZone: TextZone };
  palette: StyleTrait & { dominant: string[] };
  subject: StyleTrait & { facePresent: boolean; recurringElement: string | null };
  textTreatment: StyleTrait & {
    wordCountBand: string;
    uppercase: boolean;
    stroke: boolean;
    shadow: boolean;
  };
  mood: StyleTrait;
};

/** One distinct look that works on this channel. */
type StyleFormat = StyleTraitSet & {
  label: string;
  evidence: string[];
  lowConfidence: boolean;
};

/** One instruction from the channel playbook — see thumbnail-style.ts. */
type PlaybookRule = {
  rule: string;
  evidence: string;
  strength: "proven" | "worth-testing";
  psychology: string;
};

type StyleProfile = StyleTraitSet & {
  /** Absent on profiles analysed before formats existed — those are one look. */
  formats?: StyleFormat[];
  /** Null/absent on profiles built before the playbook existed. */
  channelRead?: string | null;
  /** Empty on profiles built before the playbook existed. */
  rules?: PlaybookRule[];
  avoid: string[];
  caveats: string[];
};

type Job = {
  running: boolean;
  done: number;
  failed: number;
  total: number;
  stage?: string;
  lastError?: string | null;
  resultId?: number | null;
};

type WindowOption = { months: number | null; label: string };

type StyleResponse = {
  channelId: string;
  profile: StyleProfile | null;
  computedAt: number | null;
  lowConfidence: boolean | null;
  ownSampleSize: number | null;
  competitorSampleSize: number | null;
  available: {
    own: number;
    competitor: number;
    competitorsTracked: number;
    minWinners: number;
    emptyReason?: string | null;
  };
  winners: { own: Winner[]; competitor: Winner[] };
  window: {
    /** What a run started right now would actually use. */
    months: number | null;
    requestedMonths: number | null;
    widened: boolean;
    provisional?: boolean;
    floor: number;
    options: WindowOption[];
    /** What the cached profile below was built from. */
    savedMonths: number | null;
    savedWidened: boolean;
  };
  stale: boolean;
  job: Job | null;
};

type Variant = {
  id: number;
  run_id: number;
  idx: number;
  base_path: string | null;
  final_path: string | null;
  overlay_json: string | null;
  error: string | null;
  /** Image is fine, something on top of it is not — see `warning` in db.ts. */
  warning: string | null;
  picked: number;
  /** Optional note on what's wrong with this cover — fed into future generations. */
  feedback: string | null;
};

type RemixOriginal = {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  views: number | null;
};

type Run = {
  id: number;
  title: string;
  prompt: string;
  provider: string;
  model: string;
  variants: number;
  aspect?: string;
  cost_cents: number | null;
  credits?: number | null;
  referenceIds: string[];
  variantsList?: Variant[];
  /** Set for remix runs: the cover that actually shipped. */
  compareWith?: RemixOriginal | null;
  /** Present on the raw DB row this is spread from; used for the per-cover "clears on" date. */
  created_at?: number;
};

type GenerateResponse = {
  channelId: string;
  job: Job | null;
  latestRun:
    | (Omit<Run, "variantsList"> & { variants: number; images?: never; variantsList?: never } & {
        variants: number;
      })
    | null;
  hasProvider: boolean;
};

type ProviderView = {
  id: number;
  provider: string;
  providerLabel: string;
  label: string;
  masked: string;
  model: string;
  modelLabel: string;
  isActive: boolean;
};

type Channel = { id: string; title: string | null };

type Idea = { id: number; title: string; stage: string };

type OwnVideo = {
  id: string;
  title: string;
  thumbnail_url: string | null;
  views: number | null;
};

/**
 * Three ways in. "Title" is the core path — a Board idea, a Signals
 * title or something typed. "Remix" regenerates covers for a video that
 * already shipped, which is the fastest way to see the generator's
 * quality against a real before/after. "Batch" is the zero-input one:
 * the app picks what to work on.
 */
type Mode = "title" | "remix" | "batch";

type HistoryRun = {
  id: number;
  title: string;
  provider: string;
  model: string;
  sourceKind: string;
  variants: number;
  aspect?: string;
  costCents: number | null;
  credits?: number | null;
  createdAt: number;
  images: Variant[];
};

type Spend = {
  totalCents: number;
  runs: number;
  runsWithoutCost: number;
  images: number;
};

/** The unpicked-cover sweep — see thumbnail-retention.ts for why it runs on request, not a schedule. */
type Retention = {
  keepDays: number;
  justCleared: number;
  justClearedMb: number;
};

function fileUrl(rel: string, version?: string): string {
  const url = `/api/thumbnails/file/${rel.split("/").map(encodeURIComponent).join("/")}`;
  // `version` is only passed for files we rewrite in place; without it
  // the URL stays byte-identical after an edit and the browser answers
  // from its own cache instead of asking us.
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function fmtCents(c: number): string {
  return c < 1 ? "<$0.01" : `$${(c / 100).toFixed(2)}`;
}

/**
 * What a run cost, in whatever unit the provider actually reported.
 *
 * Money when we have it, the provider's own credits when that is all it
 * gave us (kie bills that way and publishes no per-image rate), and a
 * plain admission otherwise. Never a converted guess.
 */
function runSpend(run: {
  cost_cents?: number | null;
  costCents?: number | null;
  credits?: number | null;
}): string {
  const cents = run.cost_cents ?? run.costCents ?? null;
  if (cents !== null) return `cost ${fmtCents(cents)}`;
  if (run.credits) return `${run.credits} provider credits`;
  return "no cost data reported by the provider";
}

export function ThumbnailsTab() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  // Board ideas are served for the ACTIVE channel only (listIdeas scopes
  // itself). When the user previews another channel here we hide the
  // idea shortcuts rather than offering cards from the wrong channel.
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [style, setStyle] = useState<StyleResponse | null>(null);
  // The style-analysis window (months of history to draw from). Starts
  // null ("use whatever the server says is saved/default") until the
  // first load tells us what that is, so the dropdown never flashes a
  // wrong value before the real one arrives.
  const [windowMonths, setWindowMonths] = useState<number | null | undefined>(
    undefined
  );
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);

  const [mode, setMode] = useState<Mode>("title");
  const [title, setTitle] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [variants, setVariants] = useState(DEFAULT_VARIANTS);
  const [aspect, setAspect] = useState<AspectChoice>(DEFAULT_ASPECT);
  // Which of the channel's winning looks to generate in. 0 is the
  // strongest, and the only one a single-look channel has — so this
  // stays correct without the user ever touching it.
  const [formatIndex, setFormatIndex] = useState(0);
  const [ownVideos, setOwnVideos] = useState<OwnVideo[]>([]);
  const [remix, setRemix] = useState<OwnVideo | null>(null);
  const [videoQuery, setVideoQuery] = useState("");
  // The board is off by default now, and batching "from the Board" then
  // fails with a message pointing at a tab the user cannot see. So the
  // default source follows whether the board is actually on, and the
  // option itself disappears when it is not.
  const [boardVisible] = useUiPref("showIdeasBoard");
  const [batchSource, setBatchSource] = useState<"ideas" | "signals" | "own">("own");
  useEffect(() => {
    if (!boardVisible && batchSource === "ideas") setBatchSource("own");
  }, [boardVisible, batchSource]);
  const [batchCount, setBatchCount] = useState(3);
  const [genJob, setGenJob] = useState<Job | null>(null);
  const [run, setRun] = useState<
    (Run & { images: Variant[] }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  // Fed by HistoryPanel's load (the only endpoint that returns it) and
  // reused here so the ResultGrid cards can state the same rule with the
  // same numbers instead of guessing or hardcoding them.
  const [retention, setRetention] = useState<Retention | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [editing, setEditing] = useState<Record<number, string>>({});

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ---------------------------------------------------------------- */

  const loadStyle = useCallback(
    async (id: string | null, windowOverride?: number | null) => {
      const params = new URLSearchParams();
      if (id) params.set("channelId", id);
      // Passing the override previews a hypothetical window (e.g. while
      // the user is scrubbing the dropdown) without saving it — only an
      // actual "Analyse" click persists a new choice.
      if (windowOverride !== undefined) {
        params.set(
          "windowMonths",
          windowOverride === null ? "all" : String(windowOverride)
        );
      }
      const qs = params.toString();
      const r = await fetch(`/api/thumbnails/style${qs ? `?${qs}` : ""}`, {
        cache: "no-store",
      });
      const j = (await r.json()) as StyleResponse & { error?: string };
      if (!r.ok) {
        setError(j.error ?? "Could not load the style profile.");
        return null;
      }
      setStyle(j);
      setError(null);
      // Keep the dropdown in sync with whatever the server resolved to
      // (saved preference, default, or the override we just sent).
      setWindowMonths(j.window.months);
      return j;
    },
    []
  );

  const loadRun = useCallback(async (id: string | null) => {
    const qs = id ? `?channelId=${encodeURIComponent(id)}` : "";
    const r = await fetch(`/api/thumbnails/generate${qs}`, { cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as {
      job: Job | null;
      latestRun: (Run & { variants: Variant[] | number }) | null;
      dryRun?: boolean;
    };
    setGenJob(j.job);
    setDryRun(!!j.dryRun);
    if (j.latestRun) {
      const images = Array.isArray(j.latestRun.variants)
        ? (j.latestRun.variants as unknown as Variant[])
        : [];
      setRun({ ...(j.latestRun as unknown as Run), images });
      setPromptDraft((prev) => prev || j.latestRun!.prompt);
    }
  }, []);

  const loadProvider = useCallback(async () => {
    const r = await fetch("/api/image-providers", { cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as { providers: ProviderView[] };
    setProvider(j.providers.find((p) => p.isActive) ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const r = await fetch("/api/channels", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { channels: Channel[]; activeId: string | null };
        setChannels(j.channels);
        setChannelId(j.activeId);
        setActiveChannelId(j.activeId);
      }
      await loadProvider();
      setLoading(false);
    })();
  }, [loadProvider]);

  useEffect(() => {
    if (channelId === null) return;
    void loadStyle(channelId);
    void loadRun(channelId);
    if (channelId !== activeChannelId) {
      setIdeas([]);
      return;
    }
    void (async () => {
      const r = await fetch("/api/ideas", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as { ideas: Idea[] };
        setIdeas(j.ideas ?? []);
      }
    })();
  }, [channelId, activeChannelId, loadStyle, loadRun]);

  // Poll while either job is running. Both jobs live on the server, so
  // this component can unmount and remount without affecting them.
  const anyRunning = !!style?.job?.running || !!genJob?.running;
  useEffect(() => {
    if (!anyRunning) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => {
      void loadStyle(channelId);
      void loadRun(channelId);
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [anyRunning, channelId, loadStyle, loadRun]);

  /* ---------------------------------------------------------------- */

  const startAnalysis = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/thumbnails/style", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, windowMonths }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) setError(j.error ?? "Could not start the analysis.");
      await loadStyle(channelId, windowMonths);
    } finally {
      setBusy(false);
    }
  };

  // Live preview only — does not save the choice. The channel's saved
  // window (or the default) is only overwritten when "Analyse" runs.
  const previewWindow = (months: number | null) => {
    setWindowMonths(months);
    void loadStyle(channelId, months);
  };

  // Own videos back the Remix picker. Loaded lazily and only for the
  // active channel, since /api/ideation/videos is scoped to it.
  useEffect(() => {
    if (mode !== "remix" || channelId !== activeChannelId) return;
    if (ownVideos.length > 0) return;
    void (async () => {
      const r = await fetch("/api/ideation/videos", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { videos: OwnVideo[] };
      setOwnVideos(j.videos ?? []);
    })();
  }, [mode, channelId, activeChannelId, ownVideos.length]);

  const startBatch = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/thumbnails/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          source: batchSource,
          count: batchCount,
          variants: Math.min(variants, 4),
          aspect,
        }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) setError(j.error ?? "Could not start the batch.");
      await loadRun(channelId);
    } finally {
      setBusy(false);
    }
  };

  const startGeneration = async (opts: { reusePrompt?: boolean } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/thumbnails/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId,
          title,
          userNote: note || null,
          variants,
          aspect,
          sourceKind: remix ? "video_remix" : sourceId ? "idea" : "manual",
          sourceId: remix ? remix.id : sourceId ?? null,
          // Clamped against THIS channel's format count. Switching from a
          // 3-look channel to a 2-look one would otherwise send an index
          // the server silently falls back to 0 for — generating a
          // different look than the one highlighted on screen.
          formatIndex: Math.min(
            formatIndex,
            Math.max(0, (style?.profile?.formats?.length ?? 1) - 1)
          ),
          prompt: opts.reusePrompt ? promptDraft : undefined,
        }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) setError(j.error ?? "Could not start generation.");
      await loadRun(channelId);
    } finally {
      setBusy(false);
    }
  };

  const rerenderOverlay = async (variant: Variant, patch: Record<string, unknown>) => {
    const r = await fetch(`/api/thumbnails/variants/${variant.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = (await r.json()) as { error?: string };
    if (!r.ok) {
      setError(j.error ?? "Could not re-render the overlay.");
      return;
    }
    setError(null);
    await loadRun(channelId);
  };

  const pick = async (variant: Variant) => {
    await fetch(`/api/thumbnails/variants/${variant.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick: true }),
    });
    await loadRun(channelId);
  };

  const saveFeedback = async (variant: Variant, feedback: string) => {
    await fetch(`/api/thumbnails/variants/${variant.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    });
    await loadRun(channelId);
  };

  const deleteVariant = async (variant: Variant) => {
    if (!confirm("Delete this cover? This can't be undone.")) return;
    await fetch(`/api/thumbnails/variants/${variant.id}`, { method: "DELETE" });
    await loadRun(channelId);
  };

  /* ---------------------------------------------------------------- */

  // null means "we have no verified rate for this model", which the UI
  // shows as "cost unknown" rather than inventing a number for a button
  // that spends money.
  const perImageCents = useMemo(() => {
    if (!provider || !isImageProviderChoice(provider.provider)) return null;
    return findModelOption(provider.provider, provider.model).estimateCents;
  }, [provider]);

  const estimateCents =
    perImageCents === null ? null : perImageCents * variants;

  const canGenerate =
    !!style?.profile && !!provider && !!title.trim() && !busy && !anyRunning;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ChannelPicker
        channels={channels}
        value={channelId}
        onChange={setChannelId}
      />

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-2 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
            <span>{error}</span>
          </CardContent>
        </Card>
      )}

      {dryRun ? (
        <Card className="border-amber-500/40">
          <CardContent className="flex items-start gap-2 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
            <span>
              <b>Dry run.</b> THUMBNAILS_DRY_RUN=1 is set, so nothing here calls
              Claude or an image provider: the style profile is a placeholder
              and every cover is drawn locally and stamped DRY RUN. Unset it in
              your <code>.env</code> for real generation.
            </span>
          </CardContent>
        </Card>
      ) : (
        <ProviderBanner provider={provider} />
      )}

      <BasisPanel
        style={style}
        onAnalyse={startAnalysis}
        busy={busy}
        windowMonths={windowMonths}
        onWindowChange={previewWindow}
        formatIndex={formatIndex}
        onSelectFormat={setFormatIndex}
      />

      <BrandAssetsPanel channelId={channelId} provider={provider} />

      {style?.profile && (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Wand2 className="h-4 w-4" /> Generate
              </div>
              <div className="flex gap-1">
                {(
                  [
                    ["title", "From a title"],
                    ["remix", "Remix a video"],
                    ["batch", "Batch"],
                  ] as Array<[Mode, string]>
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMode(m);
                      if (m !== "remix") setRemix(null);
                    }}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      mode === m
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {mode === "batch" && (
              <BatchControls
                source={batchSource}
                boardVisible={boardVisible}
                setSource={setBatchSource}
                count={batchCount}
                setCount={setBatchCount}
                perTitle={Math.min(variants, 4)}
                estimateCents={
                  estimateCents !== null
                    ? (estimateCents / variants) * Math.min(variants, 4) * batchCount
                    : null
                }
                onStart={startBatch}
                disabled={busy || anyRunning || !provider}
                running={anyRunning}
              />
            )}

            {mode === "remix" && (
              <RemixPicker
                videos={ownVideos}
                query={videoQuery}
                setQuery={setVideoQuery}
                selected={remix}
                onSelect={(v) => {
                  setRemix(v);
                  setTitle(v.title);
                  setSourceId(null);
                }}
                sameChannel={channelId === activeChannelId}
              />
            )}

            {mode === "title" && ideas.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {ideas.slice(0, 12).map((idea) => (
                  <button
                    key={idea.id}
                    type="button"
                    onClick={() => {
                      setTitle(idea.title);
                      setSourceId(idea.id);
                    }}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      sourceId === idea.id
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {idea.title.length > 44
                      ? `${idea.title.slice(0, 44)}…`
                      : idea.title}
                  </button>
                ))}
              </div>
            )}

            {mode !== "batch" && (
              <>
                <Input
                  value={title}
                  placeholder="Video title — what is this thumbnail for?"
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setSourceId(null);
                  }}
                />
                <Textarea
                  value={note}
                  rows={2}
                  placeholder="Optional. For a list video, write what each panel shows, in order — e.g. 1. giant elongated skull  2. sealed archive drawer  3. glass-case figure"
                  onChange={(e) => setNote(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Three or more numbered items are read as the panels of a
                  list cover.
                </p>
              </>
            )}

            <AspectPicker value={aspect} onChange={setAspect} />

            <div
              className={cn(
                "flex flex-wrap items-center gap-3",
                mode === "batch" && "hidden"
              )}
            >
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Variants
                <input
                  type="range"
                  min={1}
                  max={MAX_VARIANTS}
                  value={variants}
                  onChange={(e) => setVariants(Number(e.target.value))}
                  className="w-28"
                />
                <span className="w-4 font-medium text-foreground">{variants}</span>
              </label>

              <Button
                onClick={() => startGeneration()}
                disabled={!canGenerate}
                className="gap-2"
              >
                {anyRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Generate {variants}
                <span className="opacity-80">
                  {estimateCents !== null
                    ? `— ~${fmtCents(estimateCents)}`
                    : provider
                      ? "— cost unknown"
                      : ""}
                </span>
              </Button>

              <span className="text-xs text-muted-foreground">
                {estimateCents !== null
                  ? "estimate from published rates; the recorded cost comes from the provider after the run"
                  : provider
                    ? "this provider publishes no per-image price for the selected model — check your account there"
                    : ""}
              </span>
            </div>

            {genJob && (genJob.running || genJob.lastError) && (
              <JobLine job={genJob} />
            )}
          </CardContent>
        </Card>
      )}

      <HistoryPanel
        channelId={channelId}
        reloadKey={run?.id ?? 0}
        onDeleted={() => void loadRun(channelId)}
        onRetention={setRetention}
      />

      {run && run.images.length > 0 && (
        <>
          <ResultGrid
            run={run}
            editing={editing}
            setEditing={setEditing}
            onRerender={rerenderOverlay}
            onPick={pick}
            onDelete={deleteVariant}
            onFeedback={saveFeedback}
            retention={retention}
          />
          <PromptPanel
            run={run}
            open={showPrompt}
            onToggle={() => setShowPrompt((v) => !v)}
            draft={promptDraft}
            setDraft={setPromptDraft}
            onRerun={() => startGeneration({ reusePrompt: true })}
            disabled={!canGenerate}
          />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Everything generated for this channel so far, with what each run cost.
 *
 * Collapsed by default — it is reference, not the working surface — but
 * it is the only place the user can see spend accumulating and drop runs
 * they don't want, so it is never hidden behind a setting.
 */
const HISTORY_PAGE_SIZE = 20;
const HISTORY_LIMIT_CAP = 50;

function HistoryPanel({
  channelId,
  reloadKey,
  onDeleted,
  onRetention,
}: {
  channelId: string | null;
  reloadKey: number;
  onDeleted: () => void;
  onRetention: (r: Retention) => void;
}) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [retention, setRetentionState] = useState<Retention | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  // How many runs we've asked the server for. Grown by "Show more" rather
  // than paginated, since a run's own expanded covers are the thing worth
  // scrolling to, not the list of runs itself.
  const [limit, setLimit] = useState(HISTORY_PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(
    async (l: number) => {
      if (!channelId) return;
      const r = await fetch(
        `/api/thumbnails/runs?channelId=${encodeURIComponent(channelId)}&limit=${l}`,
        { cache: "no-store" }
      );
      if (!r.ok) return;
      const j = (await r.json()) as {
        runs: HistoryRun[];
        spend: Spend;
        retention: Retention;
      };
      setRuns(j.runs);
      setSpend(j.spend);
      setRetentionState(j.retention);
      onRetention(j.retention);
    },
    [channelId, onRetention]
  );

  useEffect(() => {
    void load(limit);
  }, [load, limit, reloadKey]);

  // A channel switch (or a fresh run landing) should start back at the
  // first page rather than silently keeping whatever the user had grown
  // the list to on the previous channel.
  useEffect(() => {
    setLimit(HISTORY_PAGE_SIZE);
    setExpanded(new Set());
  }, [channelId]);

  const remove = async (id: number) => {
    setBusy(true);
    try {
      await fetch(`/api/thumbnails/runs/${id}`, { method: "DELETE" });
      await load(limit);
      onDeleted();
    } finally {
      setBusy(false);
    }
  };

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickVariant = async (v: Variant) => {
    await fetch(`/api/thumbnails/variants/${v.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick: true }),
    });
    await load(limit);
    onDeleted();
  };

  const deleteVariant = async (v: Variant) => {
    if (!confirm("Delete this cover? This can't be undone.")) return;
    await fetch(`/api/thumbnails/variants/${v.id}`, { method: "DELETE" });
    await load(limit);
    onDeleted();
  };

  const filteredRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((r) => r.title.toLowerCase().includes(q));
  }, [runs, query]);

  if (runs.length === 0) return null;

  const showMore = runs.length === limit && limit < HISTORY_LIMIT_CAP;

  return (
    <Card>
      <CardContent className="py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-sm font-medium"
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          />
          History — {runs.length} run{runs.length === 1 ? "" : "s"}
          {spend && (
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {spend.images} image{spend.images === 1 ? "" : "s"} ·{" "}
              {spend.totalCents > 0
                ? `${fmtCents(spend.totalCents)} recorded`
                : "no cost recorded"}
              {spend.runsWithoutCost > 0 &&
                ` · ${spend.runsWithoutCost} run${
                  spend.runsWithoutCost === 1 ? "" : "s"
                } reported no usage`}
            </span>
          )}
        </button>

        {retention && (
          <div className="mt-1.5 space-y-0.5">
            <p className="text-xs text-muted-foreground">
              Covers you don&apos;t pick are cleared {retention.keepDays} days
              after they were made — the next time you open this tab. Picked
              covers are kept until you delete them yourself.
            </p>
            {retention.justCleared > 0 && (
              <p className="text-xs text-muted-foreground">
                Just cleared {retention.justCleared} old cover
                {retention.justCleared === 1 ? "" : "s"} (
                {retention.justClearedMb} MB).
              </p>
            )}
          </div>
        )}

        {open && (
          <div className="mt-3 space-y-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a cover by video title…"
              className="h-8 text-xs"
            />

            {filteredRuns.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No runs match &ldquo;{query}&rdquo;.
              </p>
            ) : (
              filteredRuns.map((r) => {
                const isOpen = expanded.has(r.id);
                return (
                  <div
                    key={r.id}
                    className="rounded-md border border-border text-xs"
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleExpanded(r.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleExpanded(r.id);
                        }
                      }}
                      className="flex flex-wrap items-center gap-2 p-2 cursor-pointer"
                    >
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                          isOpen && "rotate-180"
                        )}
                      />
                      <div className="flex gap-1">
                        {r.images
                          .filter((v) => v.final_path ?? v.base_path)
                          .slice(0, 4)
                          .map((v) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              key={v.id}
                              src={fileUrl((v.final_path ?? v.base_path)!)}
                              alt=""
                              className={cn(
                                "h-9 w-16 rounded object-cover",
                                v.picked === 1 && "ring-2 ring-emerald-500"
                              )}
                            />
                          ))}
                      </div>
                      <div className="min-w-[8rem] flex-1">
                        <div className="truncate font-medium">{r.title}</div>
                        <div className="text-muted-foreground">
                          {new Date(r.createdAt * 1000).toLocaleString()} ·{" "}
                          {r.sourceKind} · {r.model} ·{" "}
                          {r.aspect === "9:16" ? "9:16 Shorts" : "16:9"}
                        </div>
                      </div>
                      <span className="text-muted-foreground">
                        {r.costCents !== null
                          ? fmtCents(r.costCents)
                          : r.credits
                            ? `${r.credits} credits`
                            : "no cost data"}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(r.id);
                        }}
                        disabled={busy}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Delete run"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {isOpen && (
                      <div className="grid gap-4 border-t border-border p-3 sm:grid-cols-2">
                        {r.images.map((v) => (
                          <HistoryVariantCard
                            key={v.id}
                            variant={v}
                            onPick={pickVariant}
                            onDelete={deleteVariant}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {showMore && (
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setLimit((l) => Math.min(HISTORY_LIMIT_CAP, l + HISTORY_PAGE_SIZE))
                  }
                >
                  Show more
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One cover inside an expanded history run. Smaller and quieter than
 * `VariantCard` — this is a look-back at what was made, not the working
 * surface for a run in progress, so it skips the headline editor and the
 * feedback field and keeps only pick / download / delete.
 */
function HistoryVariantCard({
  variant,
  onPick,
  onDelete,
}: {
  variant: Variant;
  onPick: (v: Variant) => Promise<void>;
  onDelete: (v: Variant) => Promise<void>;
}) {
  // Same cache-busting key as VariantCard's overlayVersion — a headline
  // re-render rewrites the file in place, so without this the browser
  // would keep serving whatever it first cached for this cover.
  const overlayVersion = useMemo(() => {
    const s = variant.overlay_json ?? "";
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }, [variant.overlay_json]);

  if (variant.error) {
    return (
      <div className="rounded-md border border-destructive/40 p-3 text-xs">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> Variant {variant.idx + 1}{" "}
          failed
        </div>
        <div className="text-muted-foreground">{variant.error}</div>
      </div>
    );
  }

  const shown = variant.final_path ?? variant.base_path;

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border p-2",
        variant.picked ? "border-emerald-500" : "border-border"
      )}
    >
      {shown && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fileUrl(shown, overlayVersion)}
          alt="generated thumbnail"
          className="w-full rounded"
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {variant.picked ? (
          <span className="inline-flex h-8 items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" /> Picked
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => void onPick(variant)}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Pick
          </Button>
        )}
        {shown && (
          <a
            href={fileUrl(shown)}
            download
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" /> PNG
          </a>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2 text-muted-foreground hover:text-destructive"
          onClick={() => void onDelete(variant)}
          aria-label="Delete this cover"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Zero-input batch. Deliberately spells out how many images this will
 * produce and what that costs before the button is reachable — it is the
 * one control in the app that spends money on titles the user did not
 * type.
 */
function BatchControls({
  source,
  setSource,
  boardVisible,
  count,
  setCount,
  perTitle,
  estimateCents,
  onStart,
  disabled,
  running,
}: {
  source: "ideas" | "signals" | "own";
  setSource: (s: "ideas" | "signals" | "own") => void;
  boardVisible: boolean;
  count: number;
  setCount: (n: number) => void;
  perTitle: number;
  estimateCents: number | null;
  onStart: () => void;
  disabled: boolean;
  running: boolean;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">
        The app picks what to work on:{" "}
        {source === "own"
          ? "your own videos that beat this channel's median — same subjects, stronger covers"
          : source === "ideas"
          ? "the titles saved longest ago on the Ideas board"
          : "the hottest Niche Watch hits by views per hour, as your own take on the subject"}
        .
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as "ideas" | "signals" | "own")}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="own">From your own videos</option>
          {boardVisible && <option value="ideas">From the Board</option>}
          <option value="signals">From Signals</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Titles
          <input
            type="range"
            min={1}
            max={5}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-24"
          />
          <span className="w-3 font-medium text-foreground">{count}</span>
        </label>
        <Button onClick={onStart} disabled={disabled} className="gap-2">
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          Generate {count * perTitle} images
          {estimateCents !== null && (
            <span className="opacity-80">— ~{fmtCents(estimateCents)}</span>
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {count} title{count === 1 ? "" : "s"} × {perTitle} variant
        {perTitle === 1 ? "" : "s"}. Results land in the run history below.
      </p>
    </div>
  );
}

/**
 * Remix picker: regenerate covers for a video that already shipped.
 * Useful as a sanity check on the generator itself — the old cover and
 * the new one sit side by side against the same title.
 */
function RemixPicker({
  videos,
  query,
  setQuery,
  selected,
  onSelect,
  sameChannel,
}: {
  videos: OwnVideo[];
  query: string;
  setQuery: (s: string) => void;
  selected: OwnVideo | null;
  onSelect: (v: OwnVideo) => void;
  sameChannel: boolean;
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? videos.filter((v) => v.title.toLowerCase().includes(q))
      : videos;
    return base.slice(0, 24);
  }, [videos, query]);

  if (!sameChannel) {
    return (
      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        Remix reads the video list of the channel you&apos;re working in.
        Switch the app to this channel to use it.
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find one of your videos…"
        className="h-8 text-xs"
      />
      <div className="flex gap-2 overflow-x-auto pb-1">
        {filtered.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v)}
            className={cn(
              "w-32 shrink-0 rounded border p-1 text-left",
              selected?.id === v.id ? "border-primary" : "border-transparent"
            )}
            title={v.title}
          >
            {v.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={v.thumbnail_url}
                alt={v.title}
                className="h-[68px] w-full rounded object-cover"
              />
            ) : (
              <div className="h-[68px] w-full rounded bg-muted" />
            )}
            <div className="mt-1 line-clamp-2 text-[11px] leading-tight">
              {v.title}
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No videos match.
          </span>
        )}
      </div>
      {selected && (
        <p className="text-xs text-muted-foreground">
          Remixing <b className="text-foreground">{selected.title}</b> — the new
          covers use the same title, so you can compare them against the one
          that shipped.
        </p>
      )}
    </div>
  );
}

/**
 * Long-form cover or Shorts cover. Two buttons rather than a dropdown
 * because the choice changes the whole prompt, not a detail of it — the
 * style profile gets re-composed for a tall frame instead of being
 * cropped into one.
 */
function AspectPicker({
  value,
  onChange,
}: {
  value: AspectChoice;
  onChange: (a: AspectChoice) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      Format
      {ASPECT_CHOICES.map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => onChange(a)}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors",
            value === a
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border hover:text-foreground"
          )}
        >
          <span
            className={cn(
              "rounded-[2px] border border-current",
              a === "9:16" ? "h-3.5 w-2" : "h-2 w-3.5"
            )}
          />
          {a === "9:16" ? "9:16 Shorts" : "16:9 video"}
        </button>
      ))}
      <span>
        {value === "9:16"
          ? "1080x1920, composed for a tall frame"
          : "1280x720, the YouTube cover size"}
      </span>
    </div>
  );
}

function ChannelPicker({
  channels,
  value,
  onChange,
}: {
  channels: Channel[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (channels.length === 0) return null;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Channel</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
      >
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title ?? c.id}
          </option>
        ))}
      </select>
      <span className="text-xs text-muted-foreground">
        defaults to the channel you&apos;re working in
      </span>
    </div>
  );
}

function ProviderBanner({ provider }: { provider: ProviderView | null }) {
  if (!provider) {
    return (
      <Card className="border-amber-500/40">
        <CardContent className="flex items-start gap-2 py-3 text-sm">
          <Plug className="mt-0.5 h-4 w-4 text-amber-600" />
          <span>
            No image provider is active.{" "}
            <Link href="/settings" className="underline">
              Add one in Settings
            </Link>{" "}
            — Gemini, OpenAI or fal, with your own key.
          </span>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Plug className="h-3.5 w-3.5" />
      Generating with <b className="text-foreground">{provider.providerLabel}</b>
      <span className="rounded bg-muted px-1.5 py-0.5">{provider.modelLabel}</span>
      <span className="font-mono">{provider.masked}</span>
      <Link href="/settings" className="underline">
        change
      </Link>
    </div>
  );
}

/**
 * The transparency panel the brief asks for. Always visible, never
 * behind a toggle: what the generation is based on, how strong the
 * evidence is, and how to make it stronger.
 */
/** "24" -> "24 months", null -> "its full history" — used inline in prose. */
function windowPhrase(months: number | null): string {
  return months === null ? "its full history" : `the last ${months} months`;
}

function BasisPanel({
  style,
  onAnalyse,
  busy,
  windowMonths,
  onWindowChange,
  formatIndex,
  onSelectFormat,
}: {
  style: StyleResponse | null;
  onAnalyse: () => void;
  busy: boolean;
  windowMonths: number | null | undefined;
  onWindowChange: (months: number | null) => void;
  formatIndex: number;
  onSelectFormat: (i: number) => void;
}) {
  if (!style) return null;
  const { available, winners, profile, job, window: win } = style;
  const thin = available.own < available.minWinners;
  const starved = available.own + available.competitor < win.floor;

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Info className="h-4 w-4" />
            What this is based on
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Look back
              <select
                value={
                  windowMonths === undefined
                    ? ""
                    : windowMonths === null
                      ? "all"
                      : String(windowMonths)
                }
                onChange={(e) =>
                  onWindowChange(
                    e.target.value === "all" ? null : Number(e.target.value)
                  )
                }
                disabled={busy || !!job?.running}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              >
                {win.options.map((o) => (
                  <option
                    key={o.label}
                    value={o.months === null ? "all" : String(o.months)}
                  >
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={onAnalyse}
              disabled={busy || !!job?.running}
              className="gap-2"
            >
              {job?.running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {profile ? "Re-analyse style" : "Analyse what works here"}
            </Button>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          Generation uses <b className="text-foreground">your channel&apos;s</b>{" "}
          thumbnails and <b className="text-foreground">your competitors&apos;</b>{" "}
          — only videos at least 14 days old, published within your look-back
          window, ranked by views against their own channel&apos;s median.{" "}
          {available.competitorsTracked === 0 ? (
            <>
              You have no competitors tracked yet.{" "}
              <Link href="/competitors" className="underline">
                Add some on the Competitors tab
              </Link>{" "}
              to widen the reference set.
            </>
          ) : (
            <>
              {available.competitorsTracked} competitor
              {available.competitorsTracked === 1 ? "" : "s"} feed this profile.{" "}
              <Link href="/competitors" className="underline">
                Add more
              </Link>
              .
            </>
          )}
        </p>

        {win.widened && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Your chosen window (
            {win.requestedMonths === null
              ? "all time"
              : `last ${win.requestedMonths} months`}
            ) had too few thumbnails, so this preview was widened to{" "}
            {windowPhrase(win.months)} automatically.
          </p>
        )}

        <div className="flex flex-wrap gap-4 text-xs">
          <Stat label="your winners" value={available.own} />
          <Stat label="competitor winners" value={available.competitor} />
          {style.computedAt && (
            <Stat
              label="profile computed"
              value={new Date(style.computedAt * 1000).toLocaleDateString()}
            />
          )}
        </div>

        {profile && (
          <p className="text-xs text-muted-foreground">
            This profile was built from{" "}
            <b className="text-foreground">{style.ownSampleSize ?? 0}</b> of
            your thumbnails and{" "}
            <b className="text-foreground">{style.competitorSampleSize ?? 0}</b>{" "}
            competitor thumbnails, published in {windowPhrase(win.savedMonths)}
            {win.savedWidened
              ? " (widened automatically — the requested window had too few)"
              : ""}
            .
          </p>
        )}

        {starved && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {/* The count alone lied on a channel holding 35 covers that
                  were all Shorts: it read "0 thumbnails found in the
                  channel's full history". The server knows the real
                  reason, so say that first and keep the count as
                  supporting detail. */}
              {available.emptyReason ?? (
                <>
                  Only {available.own + available.competitor} thumbnail
                  {available.own + available.competitor === 1 ? "" : "s"} found
                  in {windowPhrase(win.months)} — below the {win.floor} needed
                  to learn a reliable style. Running the analysis now will
                  refuse rather than guess from this few.
                </>
              )}
            </span>
          </div>
        )}

        {win.provisional && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {/* A new channel has covers but no settled numbers. Saying
                  nothing at all was the old behaviour and it left exactly
                  the people who need this most with an empty screen. */}
              This channel is too new for settled numbers — its videos
              haven&rsquo;t had the two weeks a cover needs before its view
              count means anything. The analysis will use{" "}
              {available.own} of its covers ranked on the views so far, and
              nothing it finds will be called proven.
            </span>
          </div>
        )}

        {!starved && thin && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {/* Explicit {" "} either side of these numbers: the compiler
                  eats the plain space next to an expression here, and a
                  client's screen read "Only 0of your videos" and "Below
                  5that's a hint". Verified in the built chunk, not in the
                  source, because the source looked correct. */}
              Only {available.own}{" "}
              of your videos beat this channel&apos;s median among mature
              uploads. Below {available.minWinners}{" "}
              that&apos;s a hint, not a pattern — the generated style is worth
              testing, not trusting.
            </span>
          </div>
        )}

        {job?.running && <JobLine job={job} />}
        {job?.lastError && !job.running && (
          <div className="text-xs text-destructive">{job.lastError}</div>
        )}

        {(winners.own.length > 0 || winners.competitor.length > 0) && (
          <WinnerStrip winners={[...winners.own, ...winners.competitor]} />
        )}

        {profile && (
          <>
            <ChannelPlaybook profile={profile} />
            <div className="border-t border-border pt-3">
              <p className="text-sm font-semibold">Style details</p>
              <p className="text-xs text-muted-foreground">
                The visual grammar the image model follows.
              </p>
            </div>
            <ProfileSummary
              profile={profile}
              formatIndex={formatIndex}
              onSelectFormat={onSelectFormat}
              minWinners={available.minWinners}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-muted-foreground">{label}</div>
    </div>
  );
}

function WinnerStrip({ winners }: { winners: Winner[] }) {
  // A thumbnail can 404 — a deleted or private video, or a CDN hiccup —
  // and the browser's broken-image icon reads as "this app is broken".
  // Track the failures and render a neutral block instead. State rather
  // than an inline onError style tweak, because the handler can miss an
  // image that failed before React attached to it.
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {winners.slice(0, 16).map((w) => (
        <a
          key={`${w.sourceLabel}-${w.videoId}`}
          href={`https://youtube.com/watch?v=${w.videoId}`}
          target="_blank"
          rel="noreferrer"
          className="group w-32 shrink-0"
          title={`${w.title} — ${w.multiplier}x, ${fmtCompact(w.views)} views (${w.sourceLabel})`}
        >
          {w.thumbnailUrl && !broken[w.videoId] ? (
            // Plain img: these are remote YouTube CDN URLs and the app
            // runs locally without an image optimiser configured.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={w.thumbnailUrl}
              alt={w.title}
              className="h-[72px] w-32 rounded bg-muted object-cover"
              onError={() =>
                setBroken((prev) => ({ ...prev, [w.videoId]: true }))
              }
            />
          ) : (
            <div className="flex h-[72px] w-32 items-center justify-center rounded bg-muted px-1 text-center text-[10px] leading-tight text-muted-foreground">
              {w.title.slice(0, 40)}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1 text-[11px]">
            <span className="rounded bg-emerald-500/15 px-1 font-medium text-emerald-700 dark:text-emerald-400">
              {w.multiplier}x
            </span>
            <span className="truncate text-muted-foreground">
              {w.sourceLabel === "own" ? "yours" : w.sourceLabel}
            </span>
          </div>
        </a>
      ))}
    </div>
  );
}

/**
 * The channel playbook — what the model read off this channel's own
 * winners and underperformers, shown above the trait tables because it
 * is the "did it understand my channel" check: if channelRead is wrong,
 * nothing built on top of it is worth trusting either.
 *
 * Profiles saved before the playbook existed carry no rules at all, and
 * that case renders as a single line, not an empty heading over nothing.
 */
function ChannelPlaybook({ profile }: { profile: StyleProfile }) {
  const rules = profile.rules ?? [];

  // The mistakes list belongs to the playbook and is rendered here for
  // BOTH cases — with rules and without. It used to also appear inside
  // the trait table as a "Never" row; that row is gone, so this block
  // has to survive the no-rules path or an old profile would quietly
  // lose its avoid list on upgrade.
  const avoidBlock =
    profile.avoid.length > 0 ? (
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Avoid</p>
        {profile.avoid.map((a, i) => (
          <p key={i} className="flex gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">×</span>
            <span>{a}</span>
          </p>
        ))}
      </div>
    ) : null;

  if (rules.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          This profile was built before the playbook existed — run the
          analysis again to get it.
        </p>
        {avoidBlock}
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <div>
        <p className="font-semibold">Channel playbook</p>
        <p className="text-xs text-muted-foreground">
          What the model learned from your best and worst thumbnails. Fed
          into every generation above.
        </p>
      </div>

      {profile.channelRead && <p>{profile.channelRead}</p>}

      <ul className="space-y-2">
        {rules.map((r, i) => (
          <li key={i} className="flex gap-2">
            <span
              className={cn(
                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                r.strength === "proven" ? "bg-emerald-500" : "bg-amber-500"
              )}
            />
            <div>
              <p>{r.rule}</p>
              <p className="text-[11px] text-muted-foreground">{r.evidence}</p>
              {r.psychology && (
                <p className="text-[11px] text-muted-foreground">
                  Why it works: {r.psychology}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">
        Green: held up against this channel&apos;s own underperformers.
        Amber: worth testing — the channel&apos;s weaker thumbnails do it
        too.
      </p>

      {avoidBlock}
    </div>
  );
}

function ProfileSummary({
  profile,
  formatIndex,
  onSelectFormat,
  minWinners,
}: {
  profile: StyleProfile;
  formatIndex: number;
  onSelectFormat: (i: number) => void;
  /** The channel-wide "this is proven" bar, from the server. */
  minWinners: number;
}) {
  // Worked out here from the evidence count rather than read from the
  // stored flag, so a profile analysed before this rule changed still
  // shows an honest warning instead of the value frozen into it.
  const isThin = (f: StyleFormat) => f.evidence.length < minWinners;
  // Several looks can win on one channel. Showing only the strongest —
  // or worse, an average of all of them — is what made generated covers
  // feel generic, so each one gets its own set of traits and its own
  // button. One format (or an older profile) renders exactly as before.
  const formats = profile.formats ?? [];
  const multi = formats.length > 1;
  const shown: StyleTraitSet = multi
    ? formats[Math.min(formatIndex, formats.length - 1)]
    : profile;

  const rows: Array<[string, StyleTrait]> = [
    ["Composition", shown.composition],
    ["Colour", shown.palette],
    ["Subject", shown.subject],
    ["Headline", shown.textTreatment],
    ["Mood", shown.mood],
  ];
  return (
    <div className="space-y-1.5 border-t border-border pt-3 text-sm">
      {multi && (
        <div className="mb-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            This channel has <b>{formats.length} looks</b> that beat its median.
            Pick the one to generate in — they are different on purpose.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {formats.map((f, i) => (
              <button
                key={`${f.label}-${i}`}
                type="button"
                onClick={() => onSelectFormat(i)}
                className={
                  i === Math.min(formatIndex, formats.length - 1)
                    ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs font-medium"
                    : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-foreground/40"
                }
              >
                {f.label}
                <span className="ml-1.5 opacity-60">{f.evidence.length}</span>
                {isThin(f) && <span className="ml-1" title="Thin evidence">·</span>}
              </button>
            ))}
          </div>
          {isThin(formats[Math.min(formatIndex, formats.length - 1)]) && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Only {formats[Math.min(formatIndex, formats.length - 1)].evidence.length}{" "}
              thumbnails back this look — treat it as worth testing, not proven.
            </p>
          )}
        </div>
      )}
      {rows.map(([label, trait]) =>
        trait.summary ? (
          <div key={label} className="flex gap-2">
            <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">
              {label}
            </span>
            <span>
              {trait.summary}{" "}
              <span className="text-xs text-muted-foreground">
                (n={trait.n})
              </span>
            </span>
          </div>
        ) : null
      )}
      {/* The "Never" row lived here until the playbook took the mistakes
          list over. Two copies of the same sentences on one screen is
          the clutter this rebuild is removing, and the playbook version
          carries the proof with each entry. */}
      {profile.caveats.length > 0 && (
        <div className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <b>Worth testing, not proven:</b> {profile.caveats.join(" · ")}
        </div>
      )}
    </div>
  );
}

function JobLine({ job }: { job: Job }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {job.running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      <span>
        {job.stage ?? "working"}
        {job.total > 0 && ` — ${job.done}/${job.total}`}
        {job.failed > 0 && ` (${job.failed} failed)`}
      </span>
      {job.lastError && <span className="text-destructive">{job.lastError}</span>}
    </div>
  );
}

function ResultGrid({
  run,
  editing,
  setEditing,
  onRerender,
  onPick,
  onDelete,
  onFeedback,
  retention,
}: {
  run: Run & { images: Variant[] };
  editing: Record<number, string>;
  setEditing: (v: Record<number, string>) => void;
  onRerender: (v: Variant, patch: Record<string, unknown>) => void;
  onPick: (v: Variant) => void;
  onDelete: (v: Variant) => void;
  onFeedback: (v: Variant, feedback: string) => Promise<void>;
  retention: Retention | null;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ImageIcon className="h-4 w-4" /> {run.title}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
              {run.aspect === "9:16" ? "9:16 Shorts" : "16:9"}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">{runSpend(run)}</div>
        </div>

        {run.compareWith && <RemixComparison original={run.compareWith} />}

        <div className="grid gap-4 sm:grid-cols-2">
          {run.images.map((v) => (
            <VariantCard
              key={v.id}
              variant={v}
              vertical={run.aspect === "9:16"}
              draft={editing[v.id]}
              setDraft={(text) => setEditing({ ...editing, [v.id]: text })}
              onRerender={onRerender}
              onPick={onPick}
              onDelete={onDelete}
              onFeedback={onFeedback}
              clearsAt={
                retention && run.created_at
                  ? run.created_at + retention.keepDays * 86400
                  : null
              }
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The cover that actually shipped, shown above the generated set on a
 * remix run.
 *
 * This is the only honest way to judge the generator: not "does this
 * look good" in isolation, but "would I have clicked this instead of the
 * one that earned those views".
 */
function RemixComparison({ original }: { original: RemixOriginal }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-2">
      {original.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={original.thumbnailUrl}
          alt={original.title}
          className="h-[72px] w-32 shrink-0 rounded bg-muted object-cover"
        />
      ) : (
        <div className="h-[72px] w-32 shrink-0 rounded bg-muted" />
      )}
      <div className="min-w-0 text-xs">
        <div className="font-medium text-foreground">
          The cover that shipped
        </div>
        <div className="truncate text-muted-foreground">{original.title}</div>
        <div className="mt-0.5 text-muted-foreground">
          {original.views !== null
            ? `${fmtCompact(original.views)} views`
            : "views unknown"}{" "}
          ·{" "}
          <a
            href={`https://youtube.com/watch?v=${original.videoId}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            open on YouTube
          </a>
        </div>
      </div>
    </div>
  );
}

function VariantCard({
  variant,
  vertical,
  draft,
  setDraft,
  onRerender,
  onPick,
  onDelete,
  onFeedback,
  clearsAt,
}: {
  variant: Variant;
  /** A 9:16 cover is capped in height so two of them still fit a screen. */
  vertical: boolean;
  draft: string | undefined;
  setDraft: (s: string) => void;
  onRerender: (v: Variant, patch: Record<string, unknown>) => void;
  onPick: (v: Variant) => void;
  onDelete: (v: Variant) => void;
  onFeedback: (v: Variant, feedback: string) => Promise<void>;
  /** Unix seconds this cover's automatic sweep fires, or null when the retention info hasn't loaded yet. */
  clearsAt: number | null;
}) {
  const [showBase, setShowBase] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState(variant.feedback ?? "");
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  // The reload after a save can bring back a variant object built before
  // the PATCH lands (poll timing) — only adopt the server's value when the
  // input isn't mid-edit, so a keystroke never gets clobbered.
  useEffect(() => {
    if (!feedbackSaving) setFeedbackDraft(variant.feedback ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant.feedback]);

  const saveFeedback = async () => {
    if (feedbackDraft === (variant.feedback ?? "")) return;
    setFeedbackSaving(true);
    try {
      await onFeedback(variant, feedbackDraft);
      setFeedbackSaved(true);
      setTimeout(() => setFeedbackSaved(false), 2000);
    } finally {
      setFeedbackSaving(false);
    }
  };
  const overlay = useMemo(() => {
    if (!variant.overlay_json) return null;
    try {
      return JSON.parse(variant.overlay_json) as {
        text: string;
        zone: TextZone;
      };
    } catch {
      return null;
    }
  }, [variant.overlay_json]);

  if (variant.error) {
    return (
      <div className="rounded-md border border-destructive/40 p-3 text-xs">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> Variant {variant.idx + 1}{" "}
          failed
        </div>
        <div className="text-muted-foreground">{variant.error}</div>
      </div>
    );
  }

  const shown = showBase ? variant.base_path : variant.final_path ?? variant.base_path;
  // The composited file is rewritten in place on every headline edit, so
  // its URL has to change too or the browser shows what it already has
  // and the edit looks like it did nothing. Keyed on the overlay spec
  // because that is exactly what a re-render changes; the background
  // never moves, so it keeps its plain, cacheable URL.
  const overlayVersion = useMemo(() => {
    const s = variant.overlay_json ?? "";
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }, [variant.overlay_json]);

  return (
    <div
      className={cn(
        "space-y-2 rounded-md border p-2",
        variant.picked ? "border-emerald-500" : "border-border"
      )}
    >
      {shown && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fileUrl(shown, showBase ? undefined : overlayVersion)}
          alt={overlay?.text ?? "generated thumbnail"}
          className={cn(
            "rounded",
            vertical ? "mx-auto max-h-[460px] w-auto" : "w-full"
          )}
        />
      )}

      {variant.warning && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{variant.warning}</span>
        </div>
      )}

      {overlay && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            value={draft ?? overlay.text}
            onChange={(e) => setDraft(e.target.value)}
            className="h-8 flex-1 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() =>
              onRerender(variant, { text: draft ?? overlay.text })
            }
            title="Re-render the headline — free, no API call"
          >
            Apply
          </Button>
          <select
            value={overlay.zone}
            onChange={(e) => onRerender(variant, { zone: e.target.value })}
            className="h-8 rounded-md border border-border bg-background px-1 text-xs"
          >
            {TEXT_ZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={variant.picked ? "default" : "outline"}
          className="h-8 gap-1.5"
          onClick={() => onPick(variant)}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {variant.picked ? "Picked" : "Pick"}
        </Button>
        {shown && (
          <a
            href={fileUrl(shown)}
            download
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" /> PNG
          </a>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-2 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(variant)}
          aria-label="Delete this cover"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        {variant.base_path && variant.final_path !== variant.base_path && (
          <>
            <a
              href={fileUrl(variant.base_path)}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs"
              title="The model's picture with no headline on it — the bottom layer"
            >
              <Layers className="h-3.5 w-3.5" /> Background
            </a>
            <a
              href={`/api/thumbnails/variants/${variant.id}/layers`}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs"
              title="The headline alone on transparency, in the same position — the top layer"
            >
              <Layers className="h-3.5 w-3.5" /> Text layer
            </a>
            <button
              type="button"
              onClick={() => setShowBase((v) => !v)}
              className="text-xs text-muted-foreground underline"
            >
              {showBase ? "with text" : "background only"}
            </button>
          </>
        )}
      </div>

      {/* Optional and quiet on purpose — most people will never touch it,
          so it gets one plain line, no border, no icon, no colour. Saves
          on blur/Enter rather than per keystroke, same as the headline
          editor's "Apply" step. */}
      <div className="flex items-center gap-1.5">
        <Input
          value={feedbackDraft}
          onChange={(e) => setFeedbackDraft(e.target.value)}
          onBlur={saveFeedback}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          disabled={feedbackSaving}
          placeholder="Anything wrong with this one? (optional — helps the next batch)"
          className="h-8 flex-1 text-xs"
        />
        {feedbackSaved && (
          <span className="text-[11px] text-muted-foreground">Saved</span>
        )}
      </div>

      {variant.picked ? (
        <p className="text-[11px] text-muted-foreground">
          Kept — you picked this one.
        </p>
      ) : (
        clearsAt !== null && (
          <p className="text-[11px] text-muted-foreground">
            Clears on {new Date(clearsAt * 1000).toLocaleDateString()}
          </p>
        )
      )}
    </div>
  );
}

function PromptPanel({
  run,
  open,
  onToggle,
  draft,
  setDraft,
  onRerun,
  disabled,
}: {
  run: Run;
  open: boolean;
  onToggle: () => void;
  draft: string;
  setDraft: (s: string) => void;
  onRerun: () => void;
  disabled: boolean;
}) {
  return (
    <Card>
      <CardContent className="py-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-2 text-sm font-medium"
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          />
          Why this looks like this
        </button>

        {open && (
          <div className="mt-3 space-y-3 text-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              {run.referenceIds.length} reference thumbnails were sent, drawn
              from your winners and your competitors&apos;.
            </div>
            <Textarea
              value={draft}
              rows={7}
              onChange={(e) => setDraft(e.target.value)}
              className="font-mono text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={onRerun}
              disabled={disabled}
              className="gap-2"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Re-run with this prompt
            </Button>
            <p className="text-xs text-muted-foreground">
              Editing the headline above is free. Re-running the prompt spends
              another generation.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
