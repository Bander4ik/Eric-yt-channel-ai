"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Loader2,
  Trophy,
  BarChart3,
  ListOrdered,
  CheckCircle2,
  AlertCircle,
  RotateCw,
  BookmarkPlus,
  Check,
  BookOpen,
  Copy,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HookAnalysisBanner } from "@/components/hook-analysis-banner";
import {
  PROVIDER_CHOICES,
  providerLabel,
  type ProviderChoice,
} from "@/lib/ai-provider-types";
import { cn } from "@/lib/utils";

// localStorage key so the provider pick survives page reload — same
// pattern used elsewhere for the chat-header model dropdown.
const HOOK_PROVIDER_PREF = "yt-channel-ai.hooks.provider";

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

type Hook = {
  video_id: string;
  hook_text: string;
  formula_type: Formula;
  score_open_loop: number;
  score_value_promise: number;
  score_conflict: number;
  score_specific_language: number;
  score_identification: number;
  score_pacing: number;
  score_benefit: number;
  overall_score: number;
  strengths: string | null;
  improvements: string | null;
  analyzed_at: number;
  analyzer_model: string | null;
  title: string;
  views: number;
  published_at: number | null;
  thumbnail_url: string | null;
};

type Dashboard = {
  overall: {
    analyzed: number;
    totalVideos: number;
    avgScore: number;
    topFormula: Formula | null;
  };
  formulas: Array<{
    formula: Formula;
    count: number;
    avgViews: number;
    avgScore: number;
  }>;
  pending: number;
};

type Tab = "dashboard" | "rankings" | "cards" | "playbook";

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

const FORMULA_COLOR: Record<Formula, string> = {
  direct_question: "bg-sky-500",
  statistic: "bg-emerald-500",
  comment_reference: "bg-blue-500",
  personal_story: "bg-orange-500",
  mystery: "bg-violet-500",
  character_place_date: "bg-amber-500",
  provocation: "bg-rose-500",
  other: "bg-zinc-500",
};

const SCORE_LABELS: Array<{ key: keyof Hook; label: string; cap: string }> = [
  { key: "score_open_loop", label: "Open loop", cap: "<10s" },
  { key: "score_value_promise", label: "Value promise", cap: "" },
  { key: "score_conflict", label: "Conflict", cap: "<30s" },
  { key: "score_specific_language", label: "Specific language", cap: "" },
  { key: "score_identification", label: "Identification", cap: "<15s" },
  { key: "score_pacing", label: "Pacing", cap: "" },
  { key: "score_benefit", label: "Benefit", cap: "<60s" },
];

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
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [orderBy, setOrderBy] = useState<"score" | "views" | "recent">("score");
  // Bumped right after a batch is kicked off so HookAnalysisBanner
  // immediately re-reads /jobs/latest and starts polling — otherwise it
  // wouldn't notice the new job until a full page reload.
  const [analyzeSignal, setAnalyzeSignal] = useState(0);
  // Which AI provider drives both batch + per-video re-analysis. Undefined
  // means "let the server pick" (Claude if configured, else Gemini 2.5
  // Pro) — that's the right default for users who only have one key.
  // We restore the last picked provider from localStorage on mount so
  // the choice survives reloads.
  const [provider, setProvider] = useState<ProviderChoice | undefined>(
    undefined
  );
  useEffect(() => {
    const stored = window.localStorage.getItem(HOOK_PROVIDER_PREF);
    if (stored && PROVIDER_CHOICES.includes(stored as ProviderChoice)) {
      setProvider(stored as ProviderChoice);
    }
  }, []);
  const updateProvider = (next: ProviderChoice | undefined) => {
    setProvider(next);
    if (next) window.localStorage.setItem(HOOK_PROVIDER_PREF, next);
    else window.localStorage.removeItem(HOOK_PROVIDER_PREF);
  };

  const refresh = useCallback(async () => {
    try {
      const [dRes, hRes] = await Promise.all([
        fetch("/api/hooks/dashboard", { cache: "no-store" }),
        fetch(`/api/hooks?orderBy=${orderBy}&limit=200`, { cache: "no-store" }),
      ]);
      const d = (await dRes.json()) as Dashboard;
      const h = (await hRes.json()) as { hooks: Hook[] };
      setDashboard(d);
      setHooks(h.hooks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [orderBy]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The playbook lives on its own endpoint and its own refresh cycle —
  // generating it is a multi-second AI call, so it must not be coupled to
  // the cheap dashboard/rankings reload that runs on every sort change.
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
        body: JSON.stringify(provider ? { provider } : {}),
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
      // Pass the picked provider so the batch runs on Claude or whichever
      // Gemini variant the user selected. Empty body = server-side
      // auto-resolve (Claude if configured, else Gemini 2.5 Pro).
      const r = await fetch("/api/hooks/analyze-pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider ? { provider } : {}),
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

  const reanalyzeOne = async (videoId: string) => {
    setAnalyzingIds((prev) => new Set(prev).add(videoId));
    setError(null);
    try {
      // Same provider threading as the batch endpoint — keeps the
      // single-video Re-analyze button consistent with what the header
      // picker says.
      const r = await fetch(`/api/hooks/analyze/${videoId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider ? { provider } : {}),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setAnalyzingIds((prev) => {
        const next = new Set(prev);
        next.delete(videoId);
        return next;
      });
    }
  };

  // For the Dashboard's per-formula bars we normalise against the
  // top formula's avg views (so the longest bar is always full-width)
  // — keeps the chart legible even on channels where one formula
  // dominates by 10×.
  const maxAvgViews = useMemo(
    () => Math.max(1, ...(dashboard?.formulas.map((f) => f.avgViews) ?? [1])),
    [dashboard]
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
            AI breakdown of every opening hook — formula, quality scores,
            strengths, suggested fixes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* AI provider picker. "Auto" leaves the resolve to the server
              (Claude if its key is set, else Gemini 2.5 Pro). Explicit
              choices force a specific model — useful when both keys are
              configured and the user wants to use Gemini for cost or
              Claude for quality. Persists across reloads via
              localStorage so a return visit doesn't snap back to Auto. */}
          <select
            value={provider ?? ""}
            onChange={(e) =>
              updateProvider(
                e.target.value === ""
                  ? undefined
                  : (e.target.value as ProviderChoice)
              )
            }
            disabled={analyzing}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
            title="Which AI model scores the hooks. Auto = whichever key you've configured."
          >
            <option value="">Auto (recommended)</option>
            {PROVIDER_CHOICES.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
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

      {/* Tabs */}
      <div className="mb-4 flex gap-4 border-b border-border">
        <TabButton active={tab === "dashboard"} onClick={() => setTab("dashboard")}>
          <BarChart3 className="h-3.5 w-3.5" />
          Dashboard
        </TabButton>
        <TabButton active={tab === "rankings"} onClick={() => setTab("rankings")}>
          <ListOrdered className="h-3.5 w-3.5" />
          Rankings
        </TabButton>
        <TabButton active={tab === "cards"} onClick={() => setTab("cards")}>
          <Trophy className="h-3.5 w-3.5" />
          Video Cards
        </TabButton>
        <TabButton active={tab === "playbook"} onClick={() => setTab("playbook")}>
          <BookOpen className="h-3.5 w-3.5" />
          Playbook
        </TabButton>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      {/* ===== DASHBOARD ===== */}
      {tab === "dashboard" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi
              label="Analyzed"
              value={`${dashboard.overall.analyzed} / ${dashboard.overall.totalVideos}`}
              hint="videos scored"
            />
            <Kpi
              label="Avg Score"
              value={`${dashboard.overall.avgScore.toFixed(1)} / 10`}
              hint="across all hooks"
            />
            <Kpi
              label="Winning formula"
              value={
                dashboard.overall.topFormula
                  ? FORMULA_LABEL[dashboard.overall.topFormula]
                  : "—"
              }
              hint="by avg views"
            />
            <Kpi
              label="Pending"
              value={String(dashboard.pending)}
              hint="awaiting analysis"
            />
          </div>

          {/* Formula breakdown */}
          <Card>
            <CardContent className="p-4">
              <h2 className="mb-3 text-sm font-semibold">
                Formulas — avg views per type
              </h2>
              {dashboard.formulas.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No hooks analyzed yet. Click &ldquo;Analyze pending&rdquo;
                  above to start.
                </div>
              ) : (
                <ul className="space-y-2">
                  {dashboard.formulas.map((f) => (
                    <li key={f.formula} className="flex items-center gap-3">
                      <span className="w-44 shrink-0 text-xs">
                        {FORMULA_LABEL[f.formula]}
                      </span>
                      <div className="relative h-6 flex-1 rounded bg-muted/40">
                        <div
                          className={cn(
                            "h-full rounded transition-all",
                            FORMULA_COLOR[f.formula]
                          )}
                          style={{
                            width: `${(f.avgViews / maxAvgViews) * 100}%`,
                          }}
                        />
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-end px-2 text-[10px] font-medium text-foreground">
                          {fmtCount(f.avgViews)} avg · {f.count} vids ·{" "}
                          {f.avgScore.toFixed(1)}/10
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Score averages across dimensions */}
          {dashboard.overall.analyzed > 0 && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-3 text-sm font-semibold">
                  Quality dimensions — averages across all analyzed hooks
                </h2>
                <AverageScoresBars hooks={hooks} />
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ===== RANKINGS ===== */}
      {tab === "rankings" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Sort by:</span>
            <SortPill
              active={orderBy === "score"}
              onClick={() => setOrderBy("score")}
            >
              Score
            </SortPill>
            <SortPill
              active={orderBy === "views"}
              onClick={() => setOrderBy("views")}
            >
              Views
            </SortPill>
            <SortPill
              active={orderBy === "recent"}
              onClick={() => setOrderBy("recent")}
            >
              Recent
            </SortPill>
          </div>
          {hooks.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No hooks analyzed yet.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">Title</th>
                      <th className="px-3 py-2 text-left">Formula</th>
                      <th className="px-3 py-2 text-right">Views</th>
                      <th className="px-3 py-2 text-right">Score</th>
                      <th className="px-3 py-2 text-right">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hooks.map((h, i) => (
                      <tr
                        key={h.video_id}
                        className="border-b border-border/60 hover:bg-accent/30"
                      >
                        <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                        <td className="px-3 py-2">
                          <a
                            href={`/videos/${h.video_id}`}
                            className="hover:text-primary hover:underline"
                          >
                            {h.title}
                          </a>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white",
                              FORMULA_COLOR[h.formula_type]
                            )}
                          >
                            {FORMULA_LABEL[h.formula_type]}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtCount(h.views)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right font-semibold tabular-nums",
                            h.overall_score >= 8
                              ? "text-emerald-600 dark:text-emerald-400"
                              : h.overall_score >= 6
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-rose-600 dark:text-rose-400"
                          )}
                        >
                          {h.overall_score.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          {fmtDate(h.published_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ===== VIDEO CARDS ===== */}
      {tab === "cards" && (
        <div className="space-y-3">
          {hooks.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                No hooks analyzed yet.
              </CardContent>
            </Card>
          ) : (
            hooks.map((h) => (
              <HookCard
                key={h.video_id}
                hook={h}
                reanalyzing={analyzingIds.has(h.video_id)}
                onReanalyze={() => reanalyzeOne(h.video_id)}
              />
            ))
          )}
        </div>
      )}

      {/* ===== PLAYBOOK ===== */}
      {tab === "playbook" && (
        <PlaybookTab
          data={playbook}
          error={playbookError}
          generating={generating}
          onGenerate={generatePlaybook}
        />
      )}
    </div>
  );
}

/**
 * Consolidates every per-video hook analysis into one diagnosis plus a
 * paste-ready block of rules for the user's script-writing prompt. The
 * point of the tab is that reading 240 individual suggestions is not
 * something anyone actually does.
 */
function PlaybookTab({
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

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function SortPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
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

function AverageScoresBars({ hooks }: { hooks: Hook[] }) {
  const averages = useMemo(() => {
    if (!hooks.length) return null;
    const sum: Record<string, number> = {};
    for (const s of SCORE_LABELS) sum[s.key as string] = 0;
    for (const h of hooks) {
      for (const s of SCORE_LABELS) {
        sum[s.key as string] += h[s.key] as number;
      }
    }
    const out: Record<string, number> = {};
    for (const s of SCORE_LABELS) {
      out[s.key as string] = Math.round((sum[s.key as string] / hooks.length) * 10) / 10;
    }
    return out;
  }, [hooks]);

  if (!averages) return null;

  return (
    <ul className="space-y-1.5">
      {SCORE_LABELS.map((s) => {
        const v = averages[s.key as string];
        const color =
          v >= 8 ? "bg-emerald-500" : v >= 6 ? "bg-amber-500" : "bg-rose-500";
        return (
          <li key={s.key as string} className="flex items-center gap-3 text-xs">
            <span className="w-44 shrink-0">
              {s.label}
              {s.cap && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  ({s.cap})
                </span>
              )}
            </span>
            <div className="relative h-5 flex-1 rounded bg-muted/40">
              <div
                className={cn("h-full rounded", color)}
                style={{ width: `${(v / 10) * 100}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono font-semibold">
              {v.toFixed(1)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Save as hook" button for an analysed Video Card. Sends the analysed
 * hook text into the Hooks Library so the user can reuse it as an
 * opening line later. The whole point: you save AFTER seeing the
 * score/formula, not by guessing in the comments.
 */
function SaveHookButton({ hook }: { hook: Hook }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle"
  );

  const save = async () => {
    setState("saving");
    try {
      const res = await fetch("/api/hooks-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote: hook.hook_text,
          source_video_id: hook.video_id,
          // Carry the analysis context so the library row is meaningful:
          // formula + overall score at a glance.
          note: `${FORMULA_LABEL[hook.formula_type]} hook · scored ${hook.overall_score.toFixed(1)}/10`,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState("saved");
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  };

  return (
    <button
      type="button"
      onClick={save}
      disabled={state === "saving" || state === "saved"}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] transition-colors",
        state === "saved"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground hover:bg-primary/10 hover:text-primary"
      )}
      title={
        state === "saved"
          ? "Saved to Hooks Library"
          : "Save this hook to the Hooks Library to reuse later"
      }
    >
      {state === "saving" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === "saved" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <BookmarkPlus className="h-3.5 w-3.5" />
      )}
      {state === "saving"
        ? "Saving…"
        : state === "saved"
          ? "Saved"
          : state === "error"
            ? "Retry"
            : "Save as hook"}
    </button>
  );
}

function HookCard({
  hook,
  reanalyzing,
  onReanalyze,
}: {
  hook: Hook;
  reanalyzing: boolean;
  onReanalyze: () => void;
}) {
  const strengths = useMemo<string[]>(() => {
    try {
      return JSON.parse(hook.strengths ?? "[]");
    } catch {
      return [];
    }
  }, [hook.strengths]);
  const improvements = useMemo<string[]>(() => {
    try {
      return JSON.parse(hook.improvements ?? "[]");
    } catch {
      return [];
    }
  }, [hook.improvements]);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <a
              href={`/videos/${hook.video_id}`}
              className="block truncate text-base font-semibold hover:text-primary hover:underline"
            >
              {hook.title}
            </a>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-medium text-white",
                  FORMULA_COLOR[hook.formula_type]
                )}
              >
                {FORMULA_LABEL[hook.formula_type]}
              </span>
              <span>{fmtCount(hook.views)} views</span>
              <span>{fmtDate(hook.published_at)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-right tabular-nums",
                hook.overall_score >= 8
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : hook.overall_score >= 6
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400"
              )}
            >
              <div className="text-[10px] uppercase tracking-wide opacity-80">
                Overall
              </div>
              <div className="text-lg font-bold">
                {hook.overall_score.toFixed(1)}
              </div>
            </div>
            <button
              type="button"
              onClick={onReanalyze}
              disabled={reanalyzing}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              title="Re-analyze"
            >
              {reanalyzing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Save-as-hook lives right here on the analysed card — you
            decide what to keep AFTER seeing the score + formula. */}
        <div className="mb-3 flex justify-end">
          <SaveHookButton hook={hook} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Quality scores */}
          <div>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Quality scores
            </h3>
            <ul className="space-y-1">
              {SCORE_LABELS.map((s) => {
                const v = hook[s.key] as number;
                const color =
                  v >= 8 ? "bg-emerald-500" : v >= 6 ? "bg-amber-500" : "bg-rose-500";
                return (
                  <li key={s.key as string} className="flex items-center gap-2 text-xs">
                    <span className="w-32 shrink-0 truncate">
                      {s.label}
                      {s.cap && (
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          ({s.cap})
                        </span>
                      )}
                    </span>
                    <div className="relative h-4 flex-1 rounded bg-muted/40">
                      <div
                        className={cn("h-full rounded", color)}
                        style={{ width: `${(v / 10) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 shrink-0 text-right font-mono font-semibold">
                      {v}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Strengths + Improvements */}
          <div className="space-y-3">
            {strengths.length > 0 && (
              <div>
                <h3 className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  Strengths
                </h3>
                <ul className="space-y-1 text-xs">
                  {strengths.map((s, i) => (
                    <li key={i} className="text-muted-foreground">
                      • {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {improvements.length > 0 && (
              <div>
                <h3 className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  <AlertCircle className="h-3 w-3" />
                  Suggested improvements
                </h3>
                <ul className="space-y-1 text-xs">
                  {improvements.map((s, i) => (
                    <li key={i} className="text-muted-foreground">
                      • {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <details className="mt-3">
          <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">
            Show full hook text
          </summary>
          <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-muted/20 p-2 text-[11px] text-foreground">
            {hook.hook_text}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
