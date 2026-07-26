import "server-only";
import {
  getActiveChannelId,
  getIntegration,
  listVideos,
  listWatchNiches,
  pruneNicheHits,
  upsertNicheHit,
} from "./db";
import { fetchChannelSubscriberCounts, fetchVideos, searchYouTube, type YtVideo } from "./youtube";
import { log } from "./logger";

/**
 * Niche Watch scanning — the "search a few phrases, keep what's fresh,
 * hot, AND actually about your niche" engine behind the watch_niches /
 * niche_hits tables in db.ts.
 *
 * Universal by construction: every query is whatever the user typed as
 * a watch niche, nothing here is topic-specific — AND, as of this pass,
 * nothing here is language-specific either. This product ships to
 * clients worldwide; a Ukrainian, Bengali or Japanese channel's watch
 * niche has to work exactly as well as an English one. The expected
 * language is therefore always inferred from the user's own material
 * (see inferExpectedScript()), never assumed to be English/US.
 *
 * Per niche: one search.list call (100 units) for up to
 * SEARCH_MAX_RESULTS candidates, one videos.list batch (1 unit per 50
 * ids) for real stats, and — only for whatever survives every other
 * filter, so it's a small set — one channels.list batch (1 unit per 50
 * ids) for subscriber counts. Quota is metered for real inside
 * youtube.ts's call(); the `apiUnits` numbers returned here are only a
 * rough estimate for the UI toast.
 *
 * The filter chain (see filterCandidate() below), in order:
 *   1. Recency (MAX_AGE_DAYS) + view floor (MIN_VIEWS) — unchanged from
 *      before this pass, cheap sanity bars against evergreen/no-traction
 *      uploads.
 *   2. Language — inferred per-scan from the niche query's own script,
 *      falling back to the active channel's own recent video titles,
 *      and applied only as a per-item hard check (see
 *      inferExpectedScript / candidateLanguageMismatch). When neither
 *      source yields a confident script, NO language filtering happens
 *      at all (fail open) — an empty result is strictly worse than a
 *      few off-topic ones, so uncertainty must never cost the user
 *      their whole list.
 *   3. On-topic relevance — the query's meaningful words (stopwords
 *      dropped) must actually appear in the candidate's title/
 *      description/tags. A loose paraphrase still passes (only a
 *      majority of terms need to match); a video that merely shares a
 *      ranking algorithm's idea of "related" without using any of the
 *      niche's own words does not. Scripts that don't separate words
 *      with spaces (Chinese, Japanese, Thai...) can't be tokenized by
 *      the simple splitter below, so this check fails open for those
 *      rather than silently scoring every candidate as 0% relevant.
 * NICHE_WATCH_FILTERS_LABEL in src/components/ideation/signals-tab.tsx
 * is a SECOND COPY of this description (that component can't import a
 * server-only module) — if the chain below changes, update that string
 * too or the UI will describe a filter that no longer matches reality.
 *
 *   4. Channel-size sanity — subscriber count must fall inside a wide
 *      band so a 50-subscriber channel and a 20M-subscriber giant don't
 *      both count as "breaking out in your niche". Unknown/hidden
 *      subscriber counts are never penalized (fail open, not closed).
 */

const SEARCH_MAX_RESULTS = 25;
const MIN_VIEWS = 1000;
const MAX_AGE_DAYS = 7;

// How many of the active channel's own recent video titles to read (a
// local DB query, zero API quota) as the fallback signal for "what
// language/script does this user actually publish in", when the niche
// query itself isn't written in a recognizable script (e.g. a
// romanized query typed in Latin letters for a channel that otherwise
// publishes in Cyrillic).
const CHANNEL_TITLES_FOR_LANGUAGE_INFERENCE = 30;

// --- Script detection --------------------------------------------------
// Scripts recognized for the language filter. Han/Hiragana/Katakana are
// grouped as one "cjk" bucket because real Japanese and Chinese titles
// routinely mix them — splitting them apart would make "same language"
// comparisons fail for no reason. Hangul (Korean) is kept separate since
// it doesn't mix with the others the same way.
const SCRIPT_GROUPS: { name: string; test: (ch: string) => boolean }[] = [
  {
    name: "cjk",
    test: (ch) =>
      /\p{Script=Han}/u.test(ch) ||
      /\p{Script=Hiragana}/u.test(ch) ||
      /\p{Script=Katakana}/u.test(ch),
  },
  { name: "hangul", test: (ch) => /\p{Script=Hangul}/u.test(ch) },
  { name: "cyrillic", test: (ch) => /\p{Script=Cyrillic}/u.test(ch) },
  { name: "arabic", test: (ch) => /\p{Script=Arabic}/u.test(ch) },
  { name: "hebrew", test: (ch) => /\p{Script=Hebrew}/u.test(ch) },
  { name: "devanagari", test: (ch) => /\p{Script=Devanagari}/u.test(ch) },
  { name: "bengali", test: (ch) => /\p{Script=Bengali}/u.test(ch) },
  { name: "tamil", test: (ch) => /\p{Script=Tamil}/u.test(ch) },
  { name: "telugu", test: (ch) => /\p{Script=Telugu}/u.test(ch) },
  { name: "kannada", test: (ch) => /\p{Script=Kannada}/u.test(ch) },
  { name: "malayalam", test: (ch) => /\p{Script=Malayalam}/u.test(ch) },
  { name: "gujarati", test: (ch) => /\p{Script=Gujarati}/u.test(ch) },
  { name: "gurmukhi", test: (ch) => /\p{Script=Gurmukhi}/u.test(ch) },
  { name: "sinhala", test: (ch) => /\p{Script=Sinhala}/u.test(ch) },
  { name: "thai", test: (ch) => /\p{Script=Thai}/u.test(ch) },
  { name: "greek", test: (ch) => /\p{Script=Greek}/u.test(ch) },
  { name: "armenian", test: (ch) => /\p{Script=Armenian}/u.test(ch) },
  { name: "georgian", test: (ch) => /\p{Script=Georgian}/u.test(ch) },
  { name: "latin", test: (ch) => /\p{Script=Latin}/u.test(ch) },
];

// A script needs at least this many letters, AND this share of all
// letters present, to count as "the" script of a text. Below either bar
// the text is treated as inconclusive (null) rather than guessed at.
const MIN_LETTERS_FOR_SCRIPT = 3;
const DOMINANT_SCRIPT_RATIO = 0.5;

/** Dominant Unicode script group of `text`, or null if there aren't
 * enough letters or no script clearly dominates (inconclusive — callers
 * must treat null as "don't know", not as a script of its own). */
function dominantScript(text: string): string | null {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_LETTERS_FOR_SCRIPT) return null;

  const counts = new Map<string, number>();
  for (const ch of letters) {
    const group = SCRIPT_GROUPS.find((g) => g.test(ch));
    if (group) counts.set(group.name, (counts.get(group.name) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  if (!best) return null;
  return bestCount / letters.length >= DOMINANT_SCRIPT_RATIO ? best : null;
}

// Scripts that don't separate words with spaces — the whitespace/
// punctuation tokenizer below (tokenizeQuery/tokenizeText) cannot
// meaningfully segment these into "words" at all, so relevance-by-word-
// overlap must fail open rather than score every candidate 0%.
function isUnsegmentableScript(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const unsegmentable = letters.filter(
    (ch) =>
      /\p{Script=Han}/u.test(ch) ||
      /\p{Script=Hiragana}/u.test(ch) ||
      /\p{Script=Katakana}/u.test(ch) ||
      /\p{Script=Thai}/u.test(ch)
  );
  return unsegmentable.length / letters.length > 0.3;
}

/**
 * Language names as self-labels channels tack onto a title regardless
 * of what script the title itself happens to be typed in (e.g. a
 * Bangladeshi channel writing "... bangla" in Latin letters). Mapped to
 * the script that language is normally written in, NOT to "foreign" —
 * this is deliberately just descriptive metadata, used only by
 * comparing it against THIS user's own inferred script (see
 * candidateLanguageMismatch). A Bengali-context user sees no mismatch
 * from a "bangla" label; an English- or Ukrainian-context user does.
 * Ambiguous script families (Latin covers dozens of languages, Cyrillic
 * covers Russian/Ukrainian/Bulgarian/Serbian/etc., Arabic script covers
 * Arabic/Persian/Urdu) are intentionally left out of value positions
 * where that ambiguity would matter — see the per-language entries.
 */
const LANGUAGE_LABEL_SCRIPT: Record<string, string> = {
  hindi: "devanagari", marathi: "devanagari", nepali: "devanagari",
  bangla: "bengali", bengali: "bengali",
  tamil: "tamil", telugu: "telugu", kannada: "kannada",
  malayalam: "malayalam", gujarati: "gujarati", punjabi: "gurmukhi",
  sinhala: "sinhala", urdu: "arabic", arabic: "arabic", farsi: "arabic", persian: "arabic",
  russian: "cyrillic", ukrainian: "cyrillic", bulgarian: "cyrillic", serbian: "cyrillic",
  korean: "hangul",
  japanese: "cjk", chinese: "cjk", mandarin: "cjk", cantonese: "cjk",
  thai: "thai", greek: "greek", hebrew: "hebrew", armenian: "armenian", georgian: "georgian",
  english: "latin", spanish: "latin", french: "latin", german: "latin",
  italian: "latin", portuguese: "latin", vietnamese: "latin", indonesian: "latin",
  turkish: "latin", swahili: "latin", filipino: "latin", tagalog: "latin",
};

/** Best-effort ISO-639-1 hint for searchYouTube's relevanceLanguage,
 * used ONLY for scripts that map to one dominant YouTube-content
 * language — Latin, Cyrillic and CJK each cover many languages, so we
 * deliberately omit relevanceLanguage rather than guess for those (an
 * omitted bias is honest; a wrong guess is exactly the "built around
 * one particular user" mistake this rework exists to fix). */
const SCRIPT_LANGUAGE_HINT: Partial<Record<string, string>> = {
  bengali: "bn", devanagari: "hi", tamil: "ta", telugu: "te",
  kannada: "kn", malayalam: "ml", gujarati: "gu", gurmukhi: "pa",
  sinhala: "si", thai: "th", greek: "el", hebrew: "he",
  armenian: "hy", georgian: "ka", hangul: "ko",
};

export type NicheToScan = { id: number; query: string };

export type NicheScanResult = {
  niches: number;
  found: number;
  apiUnits: number;
};

/**
 * Infers what script/language this scan should expect, from the user's
 * own material only — never a hardcoded default:
 *   1. The niche query itself, if it's written in a recognizable script.
 *   2. Failing that, the active channel's own recent video titles.
 *   3. Failing that, null — meaning "unknown", which callers must treat
 *      as "apply no language filter at all" (fail open).
 * Exported for the throwaway demo script.
 */
export function inferExpectedScript(
  query: string,
  referenceTitles: string[]
): { script: string | null; source: "query" | "channel" | "unknown" } {
  const fromQuery = dominantScript(query);
  if (fromQuery) return { script: fromQuery, source: "query" };

  if (referenceTitles.length > 0) {
    const fromChannel = dominantScript(referenceTitles.join(" • "));
    if (fromChannel) return { script: fromChannel, source: "channel" };
  }

  return { script: null, source: "unknown" };
}

/**
 * True if this candidate's language clearly does not match
 * `expectedScript` (itself already inferred from the user, never from a
 * fixed default). Two signals, in priority order:
 *   1. An explicit language self-label in the title/description (see
 *      LANGUAGE_LABEL_SCRIPT) — takes priority because it's a
 *      deliberate statement of the content's language even when the
 *      title text itself happens to be transliterated into a different
 *      script (the "Bangladesh space documentary bangla" case: the
 *      title is plain Latin letters, but it names Bengali).
 *   2. Failing that, the dominant script of the title+description text
 *      itself.
 * If `expectedScript` is null, or neither signal is conclusive, this
 * returns false — fail open, never drop for language reasons on a
 * guess. Exported for the throwaway demo script.
 */
export function candidateLanguageMismatch(
  expectedScript: string | null,
  title: string,
  description: string
): boolean {
  if (!expectedScript) return false;

  const combined = `${title} ${description}`;
  const words = tokenizeText(combined);
  for (const w of words) {
    const labelScript = LANGUAGE_LABEL_SCRIPT[w];
    if (labelScript) return labelScript !== expectedScript;
  }

  const candidateScript = dominantScript(combined);
  if (!candidateScript) return false; // inconclusive — fail open
  return candidateScript !== expectedScript;
}

// --- Relevance -----------------------------------------------------
// Ignore these when tokenizing the niche query, so e.g. "the best space
// documentary" contributes the same meaningful terms as "space
// documentary". English-only, which is fine: it only ever trims extra
// noise words, it never gates relevance the way the language check
// does, so a non-English query just skips this trimming and tokenizes
// every word as "meaningful" instead.
const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "for", "to", "and", "or",
  "is", "are", "was", "were", "be", "been", "with", "by", "from", "that",
  "this", "it", "as", "how", "why", "what", "when", "which", "who",
  "best", "top", "new", "full", "video", "videos", "vs", "your", "my",
]);

// A candidate needs at least this fraction of the query's meaningful
// terms present in its own title/description/tags. 1 or 2-word queries
// (the common case) effectively require every term; longer queries
// tolerate a partial paraphrase.
const RELEVANCE_MIN_MATCH_RATIO = 0.5;

// --- Channel-size sanity ---------------------------------------------
// Wide on purpose, and deliberately NOT locale-specific — this is a
// sanity bar against the two extremes of channel size, not a precision
// targeting tool: MIN_SUBSCRIBERS filters out accounts too small to
// plausibly be "breaking out" (more likely a bot/spam upload than a
// real trend), MAX_SUBSCRIBERS filters out channels already so large
// that they aren't "in your niche breaking out", they're already an
// established giant regardless of niche or country. Unknown/hidden
// subscriber counts are never filtered out (fail open) — see
// scanOneNiche's use of subsByChannel below.
const MIN_SUBSCRIBERS = 50;
const MAX_SUBSCRIBERS = 5_000_000;

/** Splits a niche query into its meaningful (non-stopword) lowercase
 * words. Exported for the throwaway relevance-check demo script. */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function tokenizeText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
}

export type RelevanceResult = { relevant: boolean; matched: string[]; total: number };

/**
 * True if enough of the query's meaningful terms actually show up in
 * the candidate's own title/description/tags — the "space documentary"
 * query has to be answered by the video's own words, not just YouTube's
 * notion of relatedness.
 *
 * Fails open (relevant: true, i.e. does not gate on word overlap) in
 * two cases where literal token overlap cannot mean anything:
 *   - the query is written in a script the word-splitter can't segment
 *     into words at all (Chinese, Japanese, Thai...) — see
 *     isUnsegmentableScript; scoring every candidate 0% there would
 *     empty the list for every channel using one of those scripts.
 *   - the query's dominant script differs from the candidate's own
 *     (e.g. a Bengali-script query against a title a Bangladeshi
 *     channel wrote out in Latin letters) — a word-for-word match is
 *     never going to happen across two different vocabularies, so
 *     requiring one would wrongly reject legitimate same-language,
 *     same-market content. The language check (candidateLanguageMismatch)
 *     already does the real work of deciding "same audience or not" for
 *     exactly this situation; relevance just has to get out of its way.
 * Exported for the throwaway demo script.
 */
export function checkRelevance(
  query: string,
  title: string,
  description: string,
  tags: string[]
): RelevanceResult {
  if (isUnsegmentableScript(query)) {
    return { relevant: true, matched: [], total: 0 };
  }

  const haystackText = `${title} ${description} ${tags.join(" ")}`;
  const queryScript = dominantScript(query);
  const candidateScript = dominantScript(haystackText);
  if (queryScript && candidateScript && queryScript !== candidateScript) {
    return { relevant: true, matched: [], total: 0 };
  }

  const terms = tokenizeQuery(query);
  if (terms.length === 0) return { relevant: true, matched: [], total: 0 };

  const haystack = tokenizeText(haystackText);
  const matched = terms.filter((t) => haystack.has(t));
  const ratio = matched.length / terms.length;
  return { relevant: ratio >= RELEVANCE_MIN_MATCH_RATIO, matched, total: terms.length };
}

type FilterReason =
  | "age"
  | "views"
  | "language"
  | "relevance"
  | "channel_size";

/** Full non-network filter chain for one candidate (everything except
 * the channel-size check, which needs a batched subscriber lookup done
 * once for the whole candidate set — see scanOneNiche). */
function filterCandidate(
  query: string,
  v: YtVideo,
  cutoff: number,
  expectedScript: string | null
): FilterReason | null {
  if (v.publishedAt < cutoff) return "age";
  if (v.views < MIN_VIEWS) return "views";
  if (candidateLanguageMismatch(expectedScript, v.title, v.description)) return "language";
  if (!checkRelevance(query, v.title, v.description, v.tags).relevant) return "relevance";
  return null;
}

/**
 * Scan a single watch niche: search YouTube for its query, keep videos
 * that are fresh, popular, on-topic, in the user's own inferred
 * language, and from a plausibly-sized channel, then upsert each
 * survivor as a niche hit.
 *
 * Exported (rather than kept private inside scanWatchNiches below) so
 * the scan job route can drive niches one at a time and update job
 * progress (current query, running found-count) between calls — see
 * src/app/api/niche-watch/scan/route.ts.
 */
export async function scanOneNiche(
  niche: NicheToScan,
  apiKey: string
): Promise<{ found: number; apiUnits: number }> {
  // Infer the expected script from the query first, then the active
  // channel's own recent titles (a local DB read — zero API quota).
  // listVideos() is already scoped to the active channel internally.
  let referenceTitles: string[] = [];
  try {
    referenceTitles = listVideos({ limit: CHANNEL_TITLES_FOR_LANGUAGE_INFERENCE })
      .map((v) => v.title)
      .filter((t): t is string => Boolean(t));
  } catch {
    /* language inference just falls back to "unknown" below */
  }
  const { script: expectedScript } = inferExpectedScript(niche.query, referenceTitles);
  const languageHint = expectedScript ? SCRIPT_LANGUAGE_HINT[expectedScript] : undefined;

  // Restrict the search itself to the trend window and rank by views —
  // without publishedAfter, search returns all-time relevance hits and
  // the freshness filter below empties every scan. relevanceLanguage is
  // only ever set to a hint derived from THIS user's own inferred
  // script (never a fixed default) and only when that script maps
  // unambiguously to one language; regionCode is never guessed at all
  // (script alone can't tell you a country). Either way this is still
  // a bias, not a hard filter — candidateLanguageMismatch below does
  // the real per-item work.
  const searchResults = await searchYouTube(niche.query, apiKey, {
    type: "video",
    maxResults: SEARCH_MAX_RESULTS,
    publishedAfter: new Date(Date.now() - MAX_AGE_DAYS * 86400 * 1000).toISOString(),
    order: "viewCount",
    ...(languageHint ? { relevanceLanguage: languageHint } : {}),
  });
  let apiUnits = 100; // search.list, charged regardless of result count

  const ids = searchResults.map((r) => r.id).filter(Boolean);
  if (ids.length === 0) return { found: 0, apiUnits };

  // /videos doesn't return channelTitle (only channelId) — keep a
  // video-id -> channelTitle lookup from the search results so the hit
  // row can still store a human-readable channel name.
  const channelTitleByVideoId = new Map(
    searchResults.map((r) => [r.id, r.channelTitle])
  );

  const videos = await fetchVideos(ids, apiKey);
  apiUnits += Math.ceil(ids.length / 50);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - MAX_AGE_DAYS * 86400;

  // Age / views / language / relevance — no extra API calls, just the
  // data this niche's single search+videos call already paid for.
  const dropped: Record<FilterReason, number> = {
    age: 0,
    views: 0,
    language: 0,
    relevance: 0,
    channel_size: 0,
  };
  const survivors: YtVideo[] = [];
  for (const v of videos) {
    const reason = filterCandidate(niche.query, v, cutoff, expectedScript);
    if (reason) {
      dropped[reason]++;
    } else {
      survivors.push(v);
    }
  }

  // Channel-size sanity — one batched channels.list call (1 unit per 50
  // ids) covering only whatever survived every other filter, so this
  // never scales with SEARCH_MAX_RESULTS, only with what's left.
  let sized = survivors;
  if (survivors.length > 0) {
    const subsByChannel = await fetchChannelSubscriberCounts(
      survivors.map((v) => v.channelId),
      apiKey
    );
    apiUnits += Math.ceil(new Set(survivors.map((v) => v.channelId)).size / 50);
    sized = survivors.filter((v) => {
      const subs = subsByChannel.get(v.channelId);
      // Unknown/hidden subscriber count: fail open, don't punish it.
      if (subs === null || subs === undefined) return true;
      const inBand = subs >= MIN_SUBSCRIBERS && subs <= MAX_SUBSCRIBERS;
      if (!inBand) dropped.channel_size++;
      return inBand;
    });
  }

  let found = 0;
  for (const v of sized) {
    const hoursSincePublish = Math.max(1, (nowSeconds - v.publishedAt) / 3600);
    const vph = Math.round((v.views / hoursSincePublish) * 10) / 10;

    upsertNicheHit({
      niche_id: niche.id,
      video_id: v.id,
      title: v.title,
      channel_title: channelTitleByVideoId.get(v.id) ?? null,
      channel_yt_id: v.channelId,
      views: v.views,
      published_at: v.publishedAt,
      vph,
    });
    found++;
  }

  // Never fail silently: if we had candidates but the filter chain ate
  // every single one, log exactly which filter(s) did it so it's
  // diagnosable instead of just looking like "the feature is broken".
  if (found === 0 && videos.length > 0) {
    log.warn(
      "niche-watch",
      `Niche "${niche.query}": ${videos.length} candidates, 0 survived filtering`,
      { nicheId: niche.id, query: niche.query, expectedScript, dropped }
    );
  }

  return { found, apiUnits };
}

/**
 * Thin serial wrapper around scanOneNiche for callers that just want
 * "scan everything and tell me the totals" with no need for live
 * per-niche progress — e.g. a future cron/manual-trigger path. The
 * primary UI-facing path (POST /api/niche-watch/scan) does NOT call
 * this: it drives scanOneNiche itself in a loop so it can update the
 * job's `current` field between niches. Kept here anyway so that
 * behaviour (serial scan, per-niche error isolation, prune afterwards)
 * has exactly one implementation for any non-job caller to reuse.
 *
 * A single bad niche (search fails, transient network error, quota
 * exhausted) is caught and recorded rather than aborting the whole run.
 */
export async function scanWatchNiches(): Promise<NicheScanResult> {
  const apiKey = getIntegration("youtube")?.api_key;
  if (!apiKey) {
    throw new Error("YouTube API key is not configured. Add it in Integrations.");
  }
  if (!getActiveChannelId()) {
    throw new Error("No active channel selected");
  }

  const niches = listWatchNiches();
  let found = 0;
  let apiUnits = 0;
  let lastError: string | null = null;

  for (const niche of niches) {
    try {
      const result = await scanOneNiche(niche, apiKey);
      found += result.found;
      apiUnits += result.apiUnits;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn("niche-watch", `Scan skipped niche ${niche.id}: ${lastError}`, {
        nicheId: niche.id,
        query: niche.query,
      });
    }
  }

  try {
    pruneNicheHits();
  } catch (err) {
    log.warn("niche-watch", "pruneNicheHits failed (ignored)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { niches: niches.length, found, apiUnits };
}
