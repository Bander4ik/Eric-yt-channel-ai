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
  Loader2,
  Plug,
  RefreshCw,
  Sparkles,
  Users,
  Wand2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VARIANTS,
  findModelOption,
  MAX_VARIANTS,
  isImageProviderChoice,
} from "@/lib/image-provider-types";
import { TEXT_ZONES, type TextZone } from "@/lib/thumbnail-overlay-types";

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

type StyleProfile = {
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
  };
  winners: { own: Winner[]; competitor: Winner[] };
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
  picked: number;
};

type Run = {
  id: number;
  title: string;
  prompt: string;
  provider: string;
  model: string;
  variants: number;
  cost_cents: number | null;
  referenceIds: string[];
  variantsList?: Variant[];
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

function fileUrl(rel: string): string {
  return `/api/thumbnails/file/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function fmtCents(c: number): string {
  return c < 1 ? "<$0.01" : `$${(c / 100).toFixed(2)}`;
}

export function ThumbnailsTab() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  // Board ideas are served for the ACTIVE channel only (listIdeas scopes
  // itself). When the user previews another channel here we hide the
  // idea shortcuts rather than offering cards from the wrong channel.
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [style, setStyle] = useState<StyleResponse | null>(null);
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [variants, setVariants] = useState(DEFAULT_VARIANTS);
  const [genJob, setGenJob] = useState<Job | null>(null);
  const [run, setRun] = useState<
    (Run & { images: Variant[] }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [editing, setEditing] = useState<Record<number, string>>({});

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ---------------------------------------------------------------- */

  const loadStyle = useCallback(async (id: string | null) => {
    const qs = id ? `?channelId=${encodeURIComponent(id)}` : "";
    const r = await fetch(`/api/thumbnails/style${qs}`, { cache: "no-store" });
    const j = (await r.json()) as StyleResponse & { error?: string };
    if (!r.ok) {
      setError(j.error ?? "Could not load the style profile.");
      return null;
    }
    setStyle(j);
    setError(null);
    return j;
  }, []);

  const loadRun = useCallback(async (id: string | null) => {
    const qs = id ? `?channelId=${encodeURIComponent(id)}` : "";
    const r = await fetch(`/api/thumbnails/generate${qs}`, { cache: "no-store" });
    if (!r.ok) return;
    const j = (await r.json()) as {
      job: Job | null;
      latestRun: (Run & { variants: Variant[] | number }) | null;
    };
    setGenJob(j.job);
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
        body: JSON.stringify({ channelId }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) setError(j.error ?? "Could not start the analysis.");
      await loadStyle(channelId);
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
          sourceKind: sourceId ? "idea" : "manual",
          sourceId: sourceId ?? null,
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

  /* ---------------------------------------------------------------- */

  const estimateCents = useMemo(() => {
    if (!provider || !isImageProviderChoice(provider.provider)) return null;
    const model = findModelOption(provider.provider, provider.model);
    return model.estimateCents * variants;
  }, [provider, variants]);

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

      <ProviderBanner provider={provider} />

      <BasisPanel
        style={style}
        onAnalyse={startAnalysis}
        busy={busy}
      />

      {style?.profile && (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Wand2 className="h-4 w-4" /> Generate
            </div>

            {ideas.length > 0 && (
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
              placeholder="Optional: anything the generator should know (a specific subject, a colour to avoid…)"
              onChange={(e) => setNote(e.target.value)}
            />

            <div className="flex flex-wrap items-center gap-3">
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
                {estimateCents !== null && (
                  <span className="opacity-80">— ~{fmtCents(estimateCents)}</span>
                )}
              </Button>

              {estimateCents !== null && (
                <span className="text-xs text-muted-foreground">
                  estimate from published rates; the recorded cost comes from
                  the provider after the run
                </span>
              )}
            </div>

            {genJob && (genJob.running || genJob.lastError) && (
              <JobLine job={genJob} />
            )}
          </CardContent>
        </Card>
      )}

      {run && run.images.length > 0 && (
        <>
          <ResultGrid
            run={run}
            editing={editing}
            setEditing={setEditing}
            onRerender={rerenderOverlay}
            onPick={pick}
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
            <Link href="/integrations" className="underline">
              Add one in Integrations
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
      <Link href="/integrations" className="underline">
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
function BasisPanel({
  style,
  onAnalyse,
  busy,
}: {
  style: StyleResponse | null;
  onAnalyse: () => void;
  busy: boolean;
}) {
  if (!style) return null;
  const { available, winners, profile, job } = style;
  const thin = available.own < available.minWinners;

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Info className="h-4 w-4" />
            What this is based on
          </div>
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

        <p className="text-sm text-muted-foreground">
          Generation uses <b className="text-foreground">your channel&apos;s</b>{" "}
          thumbnails and <b className="text-foreground">your competitors&apos;</b>{" "}
          — only videos at least 14 days old, ranked by views against their own
          channel&apos;s median.{" "}
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

        {thin && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Only {available.own} of your videos beat this channel&apos;s median
              among mature uploads. Below {available.minWinners} that&apos;s a
              hint, not a pattern — the generated style is worth testing, not
              trusting.
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

        {profile && <ProfileSummary profile={profile} />}
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
          {w.thumbnailUrl ? (
            // Plain img: these are remote YouTube CDN URLs and the app
            // runs locally without an image optimiser configured.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={w.thumbnailUrl}
              alt={w.title}
              className="h-[72px] w-32 rounded object-cover"
            />
          ) : (
            <div className="h-[72px] w-32 rounded bg-muted" />
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

function ProfileSummary({ profile }: { profile: StyleProfile }) {
  const rows: Array<[string, StyleTrait]> = [
    ["Composition", profile.composition],
    ["Colour", profile.palette],
    ["Subject", profile.subject],
    ["Headline", profile.textTreatment],
    ["Mood", profile.mood],
  ];
  return (
    <div className="space-y-1.5 border-t border-border pt-3 text-sm">
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
      {profile.avoid.length > 0 && (
        <div className="flex gap-2">
          <span className="w-24 shrink-0 text-xs font-medium text-muted-foreground">
            Never
          </span>
          <span>{profile.avoid.join("; ")}</span>
        </div>
      )}
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
}: {
  run: Run & { images: Variant[] };
  editing: Record<number, string>;
  setEditing: (v: Record<number, string>) => void;
  onRerender: (v: Variant, patch: Record<string, unknown>) => void;
  onPick: (v: Variant) => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ImageIcon className="h-4 w-4" /> {run.title}
          </div>
          <div className="text-xs text-muted-foreground">
            {run.cost_cents !== null
              ? `cost ${fmtCents(run.cost_cents)}`
              : "no cost data reported by the provider"}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {run.images.map((v) => (
            <VariantCard
              key={v.id}
              variant={v}
              draft={editing[v.id]}
              setDraft={(text) => setEditing({ ...editing, [v.id]: text })}
              onRerender={onRerender}
              onPick={onPick}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function VariantCard({
  variant,
  draft,
  setDraft,
  onRerender,
  onPick,
}: {
  variant: Variant;
  draft: string | undefined;
  setDraft: (s: string) => void;
  onRerender: (v: Variant, patch: Record<string, unknown>) => void;
  onPick: (v: Variant) => void;
}) {
  const [showBase, setShowBase] = useState(false);
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
          src={fileUrl(shown)}
          alt={overlay?.text ?? "generated thumbnail"}
          className="w-full rounded"
        />
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
        {variant.base_path && variant.final_path !== variant.base_path && (
          <button
            type="button"
            onClick={() => setShowBase((v) => !v)}
            className="text-xs text-muted-foreground underline"
          >
            {showBase ? "with text" : "background only"}
          </button>
        )}
      </div>
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
