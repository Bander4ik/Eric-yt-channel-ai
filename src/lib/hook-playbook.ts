import "server-only";
import {
  channelVideoProfile,
  getActiveChannelId,
  getChannel,
  getHookPlaybook,
  hookDimensionAverages,
  hookFormulaStats,
  hookOverallStats,
  hookScoreVsViews,
  listHookFeedbackForPlaybook,
  shortsScope,
  upsertHookPlaybook,
} from "./db";
import { extractJson, resolveProvider } from "./hook-analyzer";
import { providerLabel, providerModelId, streamTurn } from "./ai-provider";
import type { ProviderChoice } from "./ai-provider-types";
import { log } from "./logger";

/**
 * Hook Playbook — consolidation of every per-video hook analysis on the
 * active channel into one diagnosis plus a paste-ready block of rules
 * for the user's own script-writing prompt.
 *
 * Why this exists: the per-video analyzer emits 2-3 strengths and 2-3
 * improvements per hook. At 40 analysed videos that's ~240 fragments
 * scattered across cards — a user cannot act on that, and the client
 * asked outright for it to be consolidated into something he can feed
 * back into his script prompt.
 *
 * The one thing that makes this hard: the per-video analyzer does not
 * know what the channel is FOR. On a sleep/relaxation channel it will
 * happily say "promise the calming payoff" and "the pacing is sedative,
 * raise the urgency" in the same card. Concatenating that raw produces
 * a prompt whose rules fight each other. So the consolidation pass gets
 * a channel-context block (title, description, catalogue shape, formula
 * table) and is instructed to read the channel's format and intent
 * FIRST, then drop or reframe any source feedback that works against it.
 *
 * Structurally this mirrors hook-analyzer.ts: same provider resolution
 * (imported from it, not re-implemented), same code-fence-tolerant JSON
 * extraction, same `{ ok: false, reason }` error shape so routes and UI
 * handle failures identically.
 */

/** Below this, a "playbook" is pattern-matching on noise. */
const MIN_HOOKS = 5;

/**
 * How many videos' feedback we ship to the model. 200 rows of title +
 * 6 short bullets sits comfortably inside a context window, and the rows
 * are views-ordered so truncation drops the least consequential videos.
 */
const FEEDBACK_LIMIT = 200;

export type PlaybookProblem = {
  theme: string;
  detail: string;
  affected: number;
  example: string;
};

export type PlaybookStrength = {
  theme: string;
  detail: string;
  affected: number;
};

export type Playbook = {
  channel_read: string;
  verdict: string;
  recurring_problems: PlaybookProblem[];
  reliable_strengths: PlaybookStrength[];
  prompt_block: string;
};

/** Computed facts shown alongside the AI text so the user can check it. */
export type PlaybookFacts = {
  dimensions: ReturnType<typeof hookDimensionAverages>;
  formulas: ReturnType<typeof hookFormulaStats>;
  scoreVsViews: ReturnType<typeof hookScoreVsViews>;
  overall: ReturnType<typeof hookOverallStats>;
};

export type StoredPlaybook = {
  playbook: Playbook;
  facts: PlaybookFacts;
};

const SYSTEM_PROMPT = `You are a YouTube channel strategist. You are given every hook analysis produced for ONE channel, plus that channel's own numbers, and you consolidate them into a single playbook the creator can act on.

Your output MUST be a single valid JSON object with this exact schema, and nothing else:

{
  "channel_read": string,
  "verdict": string,
  "recurring_problems": [ { "theme": string, "detail": string, "affected": number, "example": string } ],
  "reliable_strengths": [ { "theme": string, "detail": string, "affected": number } ],
  "prompt_block": string
}

JSON HYGIENE — these fields hold long prose, which is where JSON output usually breaks:
- Never put a raw line break inside a string value. Use \\n if you need a break.
- Never put a double quote inside a string value. When you quote hook text or feedback, wrap it in 'single quotes'.
- No trailing commas, no comments, no text before or after the object.

Field rules:

- channel_read — 1-2 sentences: what this channel is and who it is for, inferred from the channel context block (title, description, typical video length, formula mix, video titles). The user reads this to check whether you understood the channel before trusting your rules. Do not hedge; commit to a reading.
- verdict — 2-3 sentences in plain English naming the single most important thing to change about this channel's hooks. Not a list.
- recurring_problems — 3 to 5 items, most frequent first. "detail" says what it is and why it costs views ON THIS CHANNEL. "example" is one short VERBATIM quote copied from the supplied improvements, not a paraphrase.
- reliable_strengths — 2 to 4 things the channel already does well and must not lose.
- prompt_block — see below.

HONEST COUNTS: "affected" is the number of analysed hooks whose feedback actually shows that theme. Count them. Never round up, never inflate a count to make a pattern look stronger, and never report a count larger than the number of hooks supplied. If a theme only appears in 3 hooks, say 3.

GROUNDING: every claim must trace to this channel's supplied numbers or quote this channel's own analysis. Generic hook advice that would be true of any YouTube channel is a failure — the user can get that anywhere. Where a number exists, cite it.

THE prompt_block — this is the deliverable. The user pastes it verbatim into the larger prompt he uses to write scripts, so:
- Plain English, addressed to whatever model writes his scripts.
- Formatted as a titled section with rules under it. No markdown headers above level 3 (### is the largest allowed). No preamble, no sign-off, no "here is your block" — it gets pasted inside a bigger prompt.
- Every rule must trace to this channel's data. Where a rule comes from a number, state the number inline in the rule.
- Every rule must be compatible with the channel's format and intent as you described them in channel_read. If a piece of source feedback contradicts that intent — the classic case is the per-video analyzer telling a sleep or relaxation channel to raise urgency and tighten pacing — either drop that feedback or reframe it so it serves the intent. NEVER emit two rules that pull in opposite directions.
- No generic hook advice.
- Target 200-350 words.

Write in the language of the supplied channel context and feedback.`;

export type GenerateResult =
  | {
      ok: true;
      playbook: Playbook;
      facts: PlaybookFacts;
      model: string;
      hooksAnalyzed: number;
    }
  | { ok: false; reason: string };

function validatePlaybook(parsed: unknown, hookCount: number): Playbook {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Playbook generator returned non-object JSON");
  }
  const p = parsed as Record<string, unknown>;
  const str = (k: string): string => {
    const v = p[k];
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`Missing or empty field: ${k}`);
    }
    return v.trim();
  };
  // Clamp `affected` at the number of hooks we actually supplied. The
  // system prompt forbids inflation, but a count above the sample size
  // is arithmetically impossible and would undermine every other number
  // on the page, so we refuse to render it.
  const clamp = (v: unknown): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
    return Math.max(0, Math.min(hookCount, n));
  };
  const problems = Array.isArray(p.recurring_problems)
    ? (p.recurring_problems as Array<Record<string, unknown>>)
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          theme: String(x.theme ?? "").trim(),
          detail: String(x.detail ?? "").trim(),
          affected: clamp(x.affected),
          example: String(x.example ?? "").trim(),
        }))
        .filter((x) => x.theme && x.detail)
        .slice(0, 6)
    : [];
  if (problems.length === 0) {
    throw new Error("Playbook returned no recurring_problems");
  }
  const strengths = Array.isArray(p.reliable_strengths)
    ? (p.reliable_strengths as Array<Record<string, unknown>>)
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          theme: String(x.theme ?? "").trim(),
          detail: String(x.detail ?? "").trim(),
          affected: clamp(x.affected),
        }))
        .filter((x) => x.theme && x.detail)
        .slice(0, 5)
    : [];
  return {
    channel_read: str("channel_read"),
    verdict: str("verdict"),
    recurring_problems: problems,
    reliable_strengths: strengths,
    prompt_block: str("prompt_block"),
  };
}

function fmtDuration(seconds: number | null): string {
  if (!seconds) return "unknown";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Read back whatever is stored for the active channel, already parsed. */
export function getStoredPlaybook(): {
  stored: StoredPlaybook | null;
  model: string | null;
  generatedAt: number | null;
  hooksAnalyzedAtGeneration: number | null;
} {
  const channelId = getActiveChannelId();
  const empty = {
    stored: null,
    model: null,
    generatedAt: null,
    hooksAnalyzedAtGeneration: null,
  };
  if (!channelId) return empty;
  const row = getHookPlaybook(channelId);
  if (!row) return empty;
  // A playbook is written from the hook statistics, and those move the
  // moment the "ignore Shorts" switch is flipped. Serving the old one
  // would state counts that no longer match the data underneath it — and
  // its "newer hooks exist, regenerate" hint would go negative and hide
  // itself. Treat a playbook from the other setting as nothing generated
  // yet, which is exactly what it is.
  if ((row.shorts_scope ?? null) !== shortsScope(channelId)) return empty;
  try {
    return {
      stored: JSON.parse(row.payload) as StoredPlaybook,
      model: row.model,
      generatedAt: row.generated_at,
      hooksAnalyzedAtGeneration: row.hooks_analyzed,
    };
  } catch {
    // A corrupt payload should look like "nothing generated yet" rather
    // than crash the tab — the user can just regenerate.
    return empty;
  }
}

/**
 * Consolidate every hook analysis on the active channel into one
 * playbook, and persist it. One LLM call.
 */
export async function generatePlaybook(
  provider?: ProviderChoice
): Promise<GenerateResult> {
  const channelId = getActiveChannelId();
  if (!channelId) {
    return { ok: false, reason: "No active channel. Connect a channel first." };
  }

  const feedback = listHookFeedbackForPlaybook(FEEDBACK_LIMIT);
  if (feedback.length < MIN_HOOKS) {
    return {
      ok: false,
      reason: `Only ${feedback.length} hook${
        feedback.length === 1 ? "" : "s"
      } analysed on this channel. A playbook needs at least ${MIN_HOOKS} to find real patterns rather than coincidences — run "Analyze pending" on more videos first.`,
    };
  }

  const dimensions = hookDimensionAverages();
  const formulas = hookFormulaStats();
  const scoreVsViews = hookScoreVsViews();
  const overall = hookOverallStats();
  const facts: PlaybookFacts = { dimensions, formulas, scoreVsViews, overall };

  const resolved = resolveProvider(provider);
  if (!resolved) {
    return {
      ok: false,
      reason:
        "No AI provider configured. Add a Claude or Gemini API key in Settings.",
    };
  }

  const channel = getChannel();
  const profile = channelVideoProfile();

  // The channel-context block is what lets the model read format and
  // intent before it writes a single rule. Without it the consolidation
  // just averages the per-video analyzer's channel-blind opinions.
  const contextBlock = [
    `Channel title: ${channel?.title ?? "(unknown)"}`,
    `Channel description: ${(channel?.description ?? "(none)").slice(0, 1500)}`,
    `Videos in catalogue: ${profile.videoCount}`,
    `Median video length: ${fmtDuration(profile.medianDurationSeconds)}`,
    `Hooks analysed: ${overall.analyzed}`,
    `Average hook score: ${overall.avgScore} / 10`,
    "",
    "Average score per dimension (1-10) across analysed hooks:",
    `  open_loop ${dimensions.open_loop} · value_promise ${dimensions.value_promise} · conflict ${dimensions.conflict} · specific_language ${dimensions.specific_language} · identification ${dimensions.identification} · pacing ${dimensions.pacing} · benefit ${dimensions.benefit}`,
    "",
    "Hook formula performance on this channel (avg views of the videos using each):",
    ...formulas.map(
      (f) =>
        `  ${f.formula}: ${f.count} videos, avg ${f.avgViews} views, avg hook score ${f.avgScore}`
    ),
    "",
    scoreVsViews.aboveMedianAvgViews !== null &&
    scoreVsViews.belowMedianAvgViews !== null
      ? `Hook score vs views: hooks scoring above this channel's median average ${scoreVsViews.aboveMedianAvgViews} views; those at or below the median average ${scoreVsViews.belowMedianAvgViews} views (n=${scoreVsViews.n}). If those two numbers are close, hook score has NOT predicted views on this channel — say so plainly in the verdict and treat your rules as hypotheses.`
      : "Hook score vs views: not enough spread in the data to compare.",
  ].join("\n");

  const feedbackBlock = feedback
    .map((f, i) => {
      const s = parseJsonArray(f.strengths);
      const imp = parseJsonArray(f.improvements);
      return [
        `[${i + 1}] "${f.title}" — ${f.views} views · formula ${f.formula_type} · hook score ${f.overall_score}`,
        s.length ? `  strengths: ${s.map((x) => `"${x}"`).join("; ")}` : null,
        imp.length ? `  improvements: ${imp.map((x) => `"${x}"`).join("; ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  let raw: string;
  try {
    const result = await streamTurn({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `CHANNEL CONTEXT\n${contextBlock}\n\nPER-VIDEO HOOK FEEDBACK (${feedback.length} analysed hooks, highest-viewed first)\n${feedbackBlock}\n\nReturn the playbook JSON now.`,
        },
      ],
      tools: [],
      // Generous on purpose. The prompt_block alone runs 200-350 words on
      // top of five problems, four strengths and a verdict; an earlier
      // feature in this repo shipped a 2000-token cap and the JSON was
      // silently truncated mid-string, surfacing to the user as an
      // unexplained parse error.
      maxTokens: 8000,
      onText: () => {},
    });
    raw = result.content
      .filter((b): b is { type: "text"; text: string; citations: null } =>
        b.type === "text"
      )
      .map((b) => b.text)
      .join("");
    if (!raw.trim()) {
      return {
        ok: false,
        reason: `${providerLabel(resolved.provider)} returned an empty response`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `${providerLabel(resolved.provider)} call failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  // One repair attempt before giving up. Across live runs this generation
  // failed to parse about as often as it succeeded: the prose fields are long
  // and the model slips a raw line break or an unescaped quote into them.
  // extractJson repairs control characters mechanically, but an unescaped
  // quote is genuinely ambiguous, so the cheapest reliable fix is to hand the
  // broken document back and ask for it again. Throwing away a 25-second
  // generation over one stray character is not something the user should see.
  let playbook: Playbook;
  try {
    playbook = validatePlaybook(JSON.parse(extractJson(raw)), feedback.length);
  } catch (firstError) {
    const firstReason =
      firstError instanceof Error ? firstError.message : String(firstError);
    log.warn("hooks", "Playbook JSON malformed — attempting one repair", {
      provider: resolved.provider,
      error: firstReason,
    });
    try {
      const repair = await streamTurn({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        system:
          "You repair malformed JSON. Return the corrected JSON object and nothing else — no explanation, no code fence. Preserve every field and all wording exactly; only fix the syntax. Escape line breaks inside strings as \\n and replace double quotes inside string values with single quotes.",
        messages: [
          {
            role: "user",
            content: `This document failed to parse with: ${firstReason}\n\n${raw}`,
          },
        ],
        tools: [],
        maxTokens: 8000,
        onText: () => {},
      });
      const repaired = repair.content
        .filter((b): b is { type: "text"; text: string; citations: null } =>
          b.type === "text"
        )
        .map((b) => b.text)
        .join("");
      playbook = validatePlaybook(
        JSON.parse(extractJson(repaired)),
        feedback.length
      );
      log.info("hooks", "Playbook JSON repaired on second pass", {
        provider: resolved.provider,
      });
    } catch (secondError) {
      const secondReason =
        secondError instanceof Error ? secondError.message : String(secondError);
      // Log both failures — knowing the repair pass produced a *different*
      // error than the first attempt is what tells us whether the model is
      // mangling syntax or genuinely ignoring the schema.
      log.warn("hooks", "Playbook JSON still unparseable after repair", {
        raw: raw.slice(0, 800),
        provider: resolved.provider,
        firstError: firstReason,
        secondError: secondReason,
      });
      return { ok: false, reason: secondReason };
    }
  }

  const model = providerModelId(resolved.provider);
  const stored: StoredPlaybook = { playbook, facts };
  upsertHookPlaybook({
    channel_id: channelId,
    payload: JSON.stringify(stored),
    model,
    hooks_analyzed: feedback.length,
  });

  log.info("hooks", "Hook playbook generated", {
    channelId,
    hooks: feedback.length,
    provider: resolved.provider,
  });

  return {
    ok: true,
    playbook,
    facts,
    model,
    hooksAnalyzed: feedback.length,
  };
}
