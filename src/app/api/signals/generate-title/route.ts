import Anthropic from "@anthropic-ai/sdk";
import {
  getActiveChannelId,
  getIntegration,
  titleWordStats,
  topVsBottomTitles,
} from "@/lib/db";
import { packagingFormulaSummary } from "@/lib/packaging";

export const runtime = "nodejs";
export const maxDuration = 60;

const ANALYZER_MODEL = "claude-sonnet-5";

const SIGNAL_TYPES = ["gap", "fresh_outlier", "audience"] as const;
type SignalType = (typeof SIGNAL_TYPES)[number];

type GenerateTitleBody = {
  type?: unknown;
  signal?: unknown;
};

type Variant = {
  title: string;
  thumbText: string;
  rationale: string;
  angle: string | null;
  distinctFrom: string | null;
};

/**
 * POST /api/signals/generate-title
 *
 * Turns one Signals-tab row (a competitor gap keyword, a fresh
 * competitor outlier, or an audience request mined from comments) into
 * 3 grounded title candidates for THIS channel, using the channel's own
 * proven title patterns as the only source of "what works" — no
 * hardcoded topical assumptions, so this works for any niche/language.
 *
 * Body: { type: "gap" | "fresh_outlier" | "audience", signal: object }
 * where `signal` is whatever row shape the UI clicked (passed through
 * verbatim into the Claude prompt — see BUILD 3 for the exact shapes
 * each signal type carries).
 *
 * Response: { variants: [{ title, thumbText, rationale, angle,
 * distinctFrom }] } (1-3 items). `angle` is the distinct take this
 * variant argues/reveals; `distinctFrom` is a one-sentence note on how
 * it differs from the source title carried in the signal (null when
 * the signal has no title to differ from, e.g. a content gap).
 * 400: no active channel / no Claude key / bad body.
 * 502: Claude responded but we couldn't parse 1-3 valid variants out of it.
 */
export async function POST(req: Request) {
  if (!getActiveChannelId()) {
    return Response.json(
      { error: "No active channel selected." },
      { status: 400 }
    );
  }

  const apiKey = getIntegration("claude")?.api_key;
  if (!apiKey) {
    return Response.json(
      { error: "Claude API key not configured." },
      { status: 400 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as GenerateTitleBody;
  if (
    typeof body.type !== "string" ||
    !SIGNAL_TYPES.includes(body.type as SignalType)
  ) {
    return Response.json(
      { error: `Invalid signal type: ${String(body.type)}` },
      { status: 400 }
    );
  }
  if (typeof body.signal !== "object" || body.signal === null) {
    return Response.json(
      { error: "Missing signal payload." },
      { status: 400 }
    );
  }

  // Grounding: the channel's own proven patterns — top titles only (the
  // "what wins here" side of topVsBottomTitles), top title words, and the
  // cached Claude-written packaging formula (may be null; that's an
  // absent-context signal, not an error — the prompt below still works
  // with just ownTopTitles + topTitleWords).
  const ownTopTitles = topVsBottomTitles().top;
  const topTitleWords = titleWordStats({ minUses: 2, topN: 15 });
  const packagingFormula = await packagingFormulaSummary();

  const instruction =
    "You are titling the NEXT video for this specific YouTube channel. " +
    "Using the channel's own proven patterns (data below) and the given " +
    "signal, produce EXACTLY 3 title candidates: (1) NEAR-CLONE of the " +
    "channel's winning structure applied to the signal, (2) SAME " +
    "structure, different angle on the signal, (3) SAME signal topic, a " +
    "different proven hook pattern from the data. Same language as the " +
    "channel's titles.\n\n" +
    "HARD RULE — reuse structure, never substance: a hook PATTERN (the " +
    "shape of the title — question / comparison / countdown / shocking " +
    "statistic / etc.) may always be reused, that is the entire method. " +
    "The specific SUBJECT and FRAMING of a title that appears inside the " +
    "signal (e.g. a competitor's exact video title) may never be " +
    "reproduced or lightly reworded — never reuse its wording, never " +
    "just swap 1-2 words for synonyms. Apply this test to every " +
    "candidate before outputting it: if a viewer who already watched the " +
    "source video would think 'this is the same video', it is too " +
    "close — throw it out and produce a genuinely different angle on " +
    "the same territory instead. If the signal carries no title (e.g. a " +
    "content gap keyword with no single source video), this rule is " +
    "moot for that variant.\n\n" +
    "For each variant also give: (a) angle — in a few words, the " +
    "distinct take THIS video argues or reveals that the source (if " +
    "any) does not, and (b) distinctFrom — one sentence naming " +
    "concretely how this title differs from the source title in the " +
    "signal; set distinctFrom to null when the signal has no source " +
    "title to differ from (e.g. a content gap).\n\n" +
    "Each candidate also needs a matching short THUMBNAIL TEXT (<=6 " +
    "words, punchy) and a one-sentence rationale that cites the data. " +
    'STRICT JSON only: {"variants":[{"title":"...","thumbText":"...",' +
    '"rationale":"...","angle":"...","distinctFrom":"..." or null}]}';

  const payload = {
    signal: body.signal,
    ownTopTitles,
    topTitleWords,
    packagingFormula,
  };

  const client = new Anthropic({ apiKey });
  let raw: string;
  try {
    const response = await client.messages.create({
      model: ANALYZER_MODEL,
      // Each variant grew two more fields (angle, distinctFrom) on top
      // of title/thumbText/rationale, so the old 1000-token budget for
      // 3 variants is too tight — 1600 leaves headroom without letting
      // this balloon.
      max_tokens: 1600,
      // Sonnet 5 thinks by default and thinking eats into max_tokens, so disable it
      // to keep this small budget available for the JSON output.
      thinking: { type: "disabled" },
      messages: [
        {
          role: "user",
          content: `${instruction}\n\n${JSON.stringify(payload)}`,
        },
      ],
    });
    raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (e) {
    return Response.json(
      {
        error: `Claude call failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 }
    );
  }

  const variants = parseVariants(raw);
  if (!variants) {
    return Response.json(
      { error: "AI returned unparseable output — try again" },
      { status: 502 }
    );
  }

  return Response.json({ variants });
}

/** Same fenced-block-then-brace-span tolerant extraction used across the
 * codebase's other Claude call sites (comment-analyzer.ts). */
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1].trim()) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

/** Parses + validates the model's JSON into 1-3 variants with non-empty
 * title strings. Returns null on any structural failure (caller maps
 * that to a 502 asking the user to retry). thumbText/rationale are
 * coerced to "" if missing/non-string rather than failing the whole
 * variant — a title with a blank rationale is still usable. angle/
 * distinctFrom are newer, model-optional fields: coerced to null (not
 * dropped, not a parse failure) whenever missing or non-string, so a
 * model that omits them still yields usable rows. */
function parseVariants(raw: string): Variant[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const variantsRaw = (parsed as { variants?: unknown }).variants;
  if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) return null;

  const variants: Variant[] = [];
  for (const v of variantsRaw) {
    if (typeof v !== "object" || v === null) continue;
    const title = (v as { title?: unknown }).title;
    if (typeof title !== "string" || !title.trim()) continue;
    const thumbText = (v as { thumbText?: unknown }).thumbText;
    const rationale = (v as { rationale?: unknown }).rationale;
    const angle = (v as { angle?: unknown }).angle;
    const distinctFrom = (v as { distinctFrom?: unknown }).distinctFrom;
    variants.push({
      title: title.trim(),
      thumbText: typeof thumbText === "string" ? thumbText.trim() : "",
      rationale: typeof rationale === "string" ? rationale.trim() : "",
      angle: typeof angle === "string" && angle.trim() ? angle.trim() : null,
      distinctFrom:
        typeof distinctFrom === "string" && distinctFrom.trim()
          ? distinctFrom.trim()
          : null,
    });
  }

  if (variants.length === 0 || variants.length > 3) return null;
  return variants;
}

