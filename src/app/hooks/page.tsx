"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Sparkles,
  Loader2,
  AlertCircle,
  RotateCw,
  Check,
  BookOpen,
  Copy,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HookAnalysisBanner } from "@/components/hook-analysis-banner";

type HookAnalysisJob = {
  id: number;
  started_at: number;
  completed_at: number | null;
  channel_id: string | null;
  total: number;
  done: number;
  failed: number;
  current_video_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  last_error: string | null;
};

type Formula =
  | "direct_question"
  | "statistic"
  | "comment_reference"
  | "personal_story"
  | "mystery"
  | "character_place_date"
  | "provocation"
  | "other";

type Dashboard = {
  pending: number;
};

type Playbook = {
  channel_read: string;
  verdict: string;
  recurring_problems: Array<{
    theme: string;
    detail: string;
    affected: number;
    example: string;
  }>;
  reliable_strengths: Array<{
    theme: string;
    detail: string;
    affected: number;
  }>;
  prompt_block: string;
};

type PlaybookFacts = {
  dimensions: {
    n: number;
    open_loop: number | null;
    value_promise: number | null;
    conflict: number | null;
    specific_language: number | null;
    identification: number | null;
    pacing: number | null;
    benefit: number | null;
  };
  formulas: Array<{
    formula: Formula;
    count: number;
    avgViews: number;
    avgScore: number;
  }>;
  scoreVsViews: {
    aboveMedianAvgViews: number | null;
    belowMedianAvgViews: number | null;
    n: number;
  };
  overall: {
    analyzed: number;
    totalVideos: number;
    avgScore: number;
    topFormula: Formula | null;
  };
};

type PlaybookResponse = {
  playbook: { playbook: Playbook; facts: PlaybookFacts } | null;
  model: string | null;
  generatedAt: number | null;
  hooksAnalyzedAtGeneration: number | null;
  hooksAnalyzed: number;
};

const DIMENSION_LABEL: Record<
  keyof Omit<PlaybookFacts["dimensions"], "n">,
  string
> = {
  open_loop: "Open loop",
  value_promise: "Value promise",
  conflict: "Conflict",
  specific_language: "Specific language",
  identification: "Identification",
  pacing: "Pacing",
  benefit: "Benefit",
};

/** Playbooks need real sample size — mirrors MIN_HOOKS in hook-playbook.ts. */
const MIN_PLAYBOOK_HOOKS = 5;

const FORMULA_LABEL: Record<Formula, string> = {
  direct_question: "Direct Question",
  statistic: "Statistic",
  comment_reference: "Comment Reference",
  personal_story: "Personal Story",
  mystery: "Mystery",
  character_place_date: "Character + Place + Date",
  provocation: "Provocation",
  other: "Other",
};

function fmtCount(n: number | null | undefined): string {
  if (!n && n !== 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function HooksPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped right after a batch is kicked off so HookAnalysisBanner
  // immediately re-reads /jobs/latest and starts polling — otherwise it
  // wouldn't notice the new job until a full page reload.
  const [analyzeSignal, setAnalyzeSignal] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const dRes = await fetch("/api/hooks/dashboard", { cache: "no-store" });
      const d = (await dRes.json()) as Dashboard;
      setDashboard(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The playbook lives on its own endpoint and its own refresh cycle —
  // generating it is a multi-second AI call, so it must not be coupled to
  // the cheap dashboard reload.
  const [playbook, setPlaybook] = useState<PlaybookResponse | null>(null);
  const [playbookError, setPlaybookError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const refreshPlaybook = useCallback(async () => {
    try {
      const r = await fetch("/api/hooks/playbook", { cache: "no-store" });
      setPlaybook((await r.json()) as PlaybookResponse);
    } catch (e) {
      setPlaybookError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    refreshPlaybook();
  }, [refreshPlaybook]);

  const generatePlaybook = async () => {
    setPlaybookError(null);
    setGenerating(true);
    try {
      const r = await fetch("/api/hooks/playbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = (await r.json()) as { error?: string };
      // Surface the server's own message verbatim — it carries the
      // "only 3 hooks analysed" refusal and raw provider errors (empty
      // credit balance, bad key) the user needs to act on.
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      await refreshPlaybook();
    } catch (e) {
      setPlaybookError(e instanceof Error ? e.message : "failed");
    } finally {
      setGenerating(false);
    }
  };

  // Kick off a background batch and let HookAnalysisBanner take over
  // the progress UI. We don't `await` the work itself — the endpoint
  // returns immediately after enqueueing — because for 40+ videos at
  // ~10s/Claude-call the request would take minutes and the UI would
  // just spin "Analyzing…" with no feedback (and no way to cancel).
  // The previous implementation did exactly that, which is why
  // pressing the button felt like it did nothing.
  const analyzeAllPending = async () => {
    setError(null);
    try {
      // Empty body = server-side auto-resolve (Claude if configured, else
      // Gemini 2.5 Pro).
      const r = await fetch("/api/hooks/analyze-pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = (await r.json()) as {
        ok?: boolean;
        jobId?: number;
        total?: number;
        error?: string;
      };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      // Tell the banner to re-read /jobs/latest NOW so it sees the
      // freshly-created running job and starts its progress polling.
      // Without this the banner stays at job=null until a page reload.
      setAnalyzeSignal((s) => s + 1);
      // Refresh dashboard so the "Pending" count is fresh too.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  };

  // Banner pushes the running-job state up so the header button can
  // disable itself + show "Analysing…" while a batch is in flight,
  // even if the user navigates away and back (we re-read the job from
  // the server on mount).
  const handleJobChange = useCallback(
    (job: HookAnalysisJob | null) => {
      const running = job?.status === "running";
      setAnalyzing(running);
      // If a new job is running, clear any stale "batch already running"
      // toast from a previous double-click — otherwise both the toast
      // and the progress banner stack on top of each other and look
      // like contradictory state.
      if (running) setError(null);
      // When a job finishes, refresh dashboard counts so the user sees
      // "0 pending" / updated avg score without a manual reload.
      if (job && job.status !== "running") {
        refresh();
      }
    },
    [refresh]
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="mx-auto max-w-6xl">
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            Failed to load Hook Lab.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6" />
            Hook Lab
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One read of how your openings work, and a paste-ready block of
            rules for your script prompt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={analyzeAllPending}
            disabled={analyzing || dashboard.pending === 0}
            size="sm"
            className="gap-1.5"
          >
            {analyzing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {analyzing
              ? "Analyzing…"
              : dashboard.pending === 0
                ? "All analyzed"
                : `Analyze ${dashboard.pending} pending`}
          </Button>
        </div>
      </header>

      {/* Background-job banner: shows progress + cancel while a batch
          is in flight, completion summary afterwards. Pushes the
          running-job state up so the header button stays disabled. */}
      <HookAnalysisBanner
        onJobChange={handleJobChange}
        pollSignal={analyzeSignal}
      />

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      <PlaybookPanel
        data={playbook}
        error={playbookError}
        generating={generating}
        onGenerate={generatePlaybook}
      />
    </div>
  );
}

/**
 * Consolidates every per-video hook analysis into one diagnosis plus a
 * paste-ready block of rules for the user's script-writing prompt. The
 * point of this panel is that reading 240 individual suggestions is not
 * something anyone actually does.
 */
function PlaybookPanel({
  data,
  error,
  generating,
  onGenerate,
}: {
  data: PlaybookResponse | null;
  error: string | null;
  generating: boolean;
  onGenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyPromptBlock = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — the text is on screen and selectable anyway */
    }
  };

  const errorBanner = error ? (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {error}
    </div>
  ) : null;

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  const stored = data.playbook;
  const notEnough = data.hooksAnalyzed < MIN_PLAYBOOK_HOOKS;

  // ---- Empty state --------------------------------------------------
  if (!stored) {
    return (
      <div className="space-y-3">
        {errorBanner}
        <Card>
          <CardContent className="space-y-4 py-10 text-center">
            <BookOpen className="mx-auto h-8 w-8 text-muted-foreground" />
            <div className="mx-auto max-w-lg space-y-2 text-sm text-muted-foreground">
              <p>
                The Playbook reads every hook analysis on this channel at
                once and turns them into one diagnosis — the problems that
                keep repeating, the strengths worth protecting — instead of
                a few hundred separate suggestions spread across cards.
              </p>
              <p>
                It ends with a block of rules you can paste straight into
                the prompt you write scripts with, built from this
                channel&rsquo;s own numbers.
              </p>
            </div>
            {/* Prose that mixes in values is built as one template string,
                not interleaved JSX: interleaving here silently dropped an
                inter-word space at compile time — invisible in review,
                visible on screen. */}
            {notEnough ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {`Only ${data.hooksAnalyzed} hook${
                  data.hooksAnalyzed === 1 ? "" : "s"
                } analyzed so far. The Playbook needs at least ${MIN_PLAYBOOK_HOOKS} to find real patterns — use the “Analyze pending” button at the top of this page first.`}
              </p>
            ) : (
              <Button onClick={onGenerate} disabled={generating} className="gap-1.5">
                {generating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {generating
                  ? "Building playbook…"
                  : `Generate from ${data.hooksAnalyzed} hooks`}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- Generated playbook -------------------------------------------
  const { playbook: pb, facts } = stored;
  const dims = facts.dimensions;
  const dimEntries = (
    Object.keys(DIMENSION_LABEL) as Array<keyof typeof DIMENSION_LABEL>
  )
    .map((k) => ({ key: k, value: dims[k] }))
    .filter((d): d is { key: keyof typeof DIMENSION_LABEL; value: number } =>
      typeof d.value === "number"
    );
  const weakest = dimEntries.reduce<typeof dimEntries[number] | null>(
    (min, d) => (min === null || d.value < min.value ? d : min),
    null
  );
  const strongest = dimEntries.reduce<typeof dimEntries[number] | null>(
    (max, d) => (max === null || d.value > max.value ? d : max),
    null
  );
  const topFormula = facts.formulas[0] ?? null;
  // How much better the winning formula does than the channel's own
  // average — "1.0x" would mean the winner isn't actually winning.
  const channelAvgViews =
    facts.formulas.length > 0
      ? facts.formulas.reduce((s, f) => s + f.avgViews * f.count, 0) /
        Math.max(
          1,
          facts.formulas.reduce((s, f) => s + f.count, 0)
        )
      : 0;
  const topMultiple =
    topFormula && channelAvgViews > 0
      ? topFormula.avgViews / channelAvgViews
      : null;

  const svv = facts.scoreVsViews;
  // "Meaningfully higher" = at least 15% above. Below that the split is
  // noise on catalogues this size, and telling the user the analyzer's
  // scores predict views would be selling them a correlation we can't see.
  const scoreTracksViews =
    svv.aboveMedianAvgViews !== null &&
    svv.belowMedianAvgViews !== null &&
    svv.aboveMedianAvgViews >= svv.belowMedianAvgViews * 1.15;
  const showCaution =
    svv.aboveMedianAvgViews !== null &&
    svv.belowMedianAvgViews !== null &&
    !scoreTracksViews;

  const newSince =
    data.hooksAnalyzedAtGeneration !== null
      ? data.hooksAnalyzed - data.hooksAnalyzedAtGeneration
      : 0;

  return (
    <div className="space-y-4">
      {errorBanner}

      {/* Provenance + regenerate */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {`Generated from ${data.hooksAnalyzedAtGeneration ?? "?"} hooks · ${
            data.generatedAt ? fmtDate(data.generatedAt) : "—"
          } · ${data.model ?? "unknown model"}`}
          {newSince > 0 && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">
              {`${newSince} newer hook${
                newSince === 1 ? "" : "s"
              } analyzed since — regenerate to include them.`}
            </span>
          )}
        </div>
        <Button
          onClick={onGenerate}
          disabled={generating}
          size="sm"
          variant="outline"
          className="gap-1.5"
        >
          {generating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCw className="h-3.5 w-3.5" />
          )}
          {generating ? "Building playbook…" : "Regenerate"}
        </Button>
      </div>

      {/* channel_read — labelled so the user can catch a misread channel
          before trusting any rule built on top of it. */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            How the AI read this channel — check this first
          </h2>
          <p className="text-sm">{pb.channel_read}</p>
        </CardContent>
      </Card>

      {/* verdict */}
      <Card className="border-primary/40">
        <CardContent className="p-4">
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Verdict
          </h2>
          <p className="text-sm leading-relaxed">{pb.verdict}</p>
        </CardContent>
      </Card>

      {/* Diagnosis strip — pure SQL, no AI. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi
          label="Weakest dimension"
          value={weakest ? DIMENSION_LABEL[weakest.key] : "—"}
          hint={weakest ? `${weakest.value.toFixed(1)} / 10 average` : ""}
        />
        <Kpi
          label="Strongest dimension"
          value={strongest ? DIMENSION_LABEL[strongest.key] : "—"}
          hint={strongest ? `${strongest.value.toFixed(1)} / 10 average` : ""}
        />
        <Kpi
          label="Winning formula"
          value={topFormula ? FORMULA_LABEL[topFormula.formula] : "—"}
          hint={
            topFormula
              ? `${fmtCount(topFormula.avgViews)} avg views${
                  topMultiple ? ` · ${topMultiple.toFixed(1)}× channel avg` : ""
                }`
              : ""
          }
        />
      </div>

      {showCaution && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {`On this channel, hook score has not tracked views so far: higher-scoring hooks averaged ${fmtCount(
              svv.aboveMedianAvgViews
            )} views against ${fmtCount(
              svv.belowMedianAvgViews
            )} for the lower-scoring half (n=${svv.n}). Treat the rules below as hypotheses to test, not proven wins.`}
          </span>
        </div>
      )}

      {/* Recurring problems */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 text-sm font-semibold">
            What keeps going wrong
          </h2>
          <ul className="space-y-3">
            {pb.recurring_problems.map((p, i) => (
              <li key={i} className="border-l-2 border-rose-500/50 pl-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{p.theme}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {`${p.affected} of ${data.hooksAnalyzedAtGeneration ?? "?"} hooks`}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{p.detail}</p>
                {p.example && (
                  <p className="mt-1 text-xs italic text-muted-foreground/80">
                    &ldquo;{p.example}&rdquo;
                  </p>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Reliable strengths */}
      {pb.reliable_strengths.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h2 className="mb-3 text-sm font-semibold">
              What already works — don&rsquo;t lose it
            </h2>
            <ul className="space-y-3">
              {pb.reliable_strengths.map((s, i) => (
                <li key={i} className="border-l-2 border-emerald-500/50 pl-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{s.theme}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {`${s.affected} of ${data.hooksAnalyzedAtGeneration ?? "?"} hooks`}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {s.detail}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* The deliverable */}
      <Card className="border-primary/40">
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">
                Paste this into your script prompt
              </h2>
              <p className="text-xs text-muted-foreground">
                Rules built from this channel&rsquo;s own hook data.
              </p>
            </div>
            <Button
              size="sm"
              variant={copied ? "outline" : "default"}
              className="shrink-0 gap-1.5"
              onClick={() => copyPromptBlock(pb.prompt_block)}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {pb.prompt_block}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="mt-1 truncate text-base font-semibold">{value}</div>
        <div className="text-[10px] text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}
