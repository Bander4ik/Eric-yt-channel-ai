import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
  getIntegration,
  listCompetitorThumbnailWinners,
  listOwnThumbnailWinners,
  recordClaudeUsage,
  type ThumbnailWinner,
} from "./db";
import { streamTurn, type UnifiedUsage } from "./ai-provider";
import {
  DEFAULT_GEMINI_PROVIDER,
  providerModelId,
  type ProviderChoice,
} from "./ai-provider-types";
import { costMillicents } from "./claude-pricing";
import { DEFAULT_ASPECT, type AspectChoice } from "./image-provider-types";
import { log } from "./logger";
import { coerceZone, type TextZone } from "./thumbnail-overlay";
import { dryRunProfile, dryRunPrompt, isDryRun } from "./thumbnail-dryrun";

/**
 * Where a channel's thumbnail style comes from, and how it turns into a
 * prompt.
 *
 * The pipeline has two halves and they are kept strictly apart:
 *
 *   DETERMINISTIC — which thumbnails count as winners, and by how much.
 *   That is SQL over live view counts (see `listOwnThumbnailWinners` /
 *   `listCompetitorThumbnailWinners` in db.ts), using the same maturity
 *   and sample-size guards the Packaging tab already applies. No model
 *   gets a vote in what "successful" means.
 *
 *   DESCRIPTIVE — what those winners have in common visually. That needs
 *   eyes, so Claude looks at the images and reports the pattern. It is
 *   told the multipliers and is required to attribute every trait to the
 *   videos that support it, so the profile can be audited against the
 *   database by hand.
 *
 * The statistical rule the rest of the app follows applies here too:
 * fewer than MIN_WINNERS confirmed winners does not make a rule. The
 * profile is still produced — a new channel deserves something — but it
 * is flagged low-confidence and the UI says so before the user spends
 * money on it.
 */

/**
 * Which model reads the thumbnails and writes the prompt.
 *
 * Not hardcoded to Claude. The app already drives either Anthropic or
 * Gemini through `ai-provider.ts`, including image input, and Google
 * hands out a free API key with no card attached. Tying this feature to
 * a paid Anthropic account would have made the whole tab unreachable for
 * anyone without one, for no technical reason.
 *
 * Selection is by which key is present, Claude first because its vision
 * output has been the more literal of the two in this codebase's
 * experience with thumbnail OCR. A user with both keys can flip the
 * order by clearing one. Which model each side resolves to lives in
 * `ai-provider-types.ts` — don't hardcode an id here.
 */
export type AnalysisProvider = {
  provider: ProviderChoice;
  apiKey: string;
  /** The model id actually sent, for logging and usage accounting. */
  model: string;
};

export function resolveAnalysisProvider(): AnalysisProvider | null {
  const claudeKey = getIntegration("claude")?.api_key;
  if (claudeKey) {
    return {
      provider: "claude",
      apiKey: claudeKey,
      model: providerModelId("claude"),
    };
  }
  const geminiKey = getIntegration("google_gemini")?.api_key;
  if (geminiKey) {
    return {
      provider: DEFAULT_GEMINI_PROVIDER,
      apiKey: geminiKey,
      model: providerModelId(DEFAULT_GEMINI_PROVIDER),
    };
  }
  return null;
}

/** Matches FORMULA_MIN_USES in packaging.ts — one bar across the app. */
export const MIN_WINNERS = 5;

/**
 * How many distinct looks we let the analysis find.
 *
 * The floor is 1 on purpose: some channels really do run one cover
 * format, and inventing a second one to fill a quota is the same failure
 * as flattening two real ones into an average — just in the other
 * direction. The ceiling is 3 because past that the "formats" stop being
 * formats and become a list of individual thumbnails.
 */
const MIN_FORMATS = 1;
const MAX_FORMATS = 3;

/**
 * Images needed before a group counts as a format at all.
 *
 * Deliberately lower than MIN_WINNERS: that bar is for a channel-wide
 * claim ("this channel always does X"), while a format is a claim about
 * a subset. Two images are a coincidence; three are a pattern worth
 * showing, flagged as thin.
 */
const MIN_FORMAT_EVIDENCE = 3;

/**
 * How many playbook rules we keep. Past eight the list stops being
 * something a person follows before making a cover and becomes another
 * wall to skim — which is the complaint this whole rebuild came from.
 */
const MAX_RULES = 8;

/**
 * How many below-median covers go in as the control group.
 *
 * Four, matching the build a client already runs successfully on his own
 * channels. It is enough for a repeated failure to show up twice, and
 * few enough that the model cannot mistake one bad month for a rule.
 */
export const MAX_OWN_LOSER_REFS = 4;

export const MAX_OWN_REFS = 12;
export const MAX_COMPETITOR_REFS = 12;

/** A cached profile older than this is recomputed on the next visit. */
export const PROFILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Style window — how far back a thumbnail can be and still count
 * ------------------------------------------------------------------ *
 *
 * The maturity floor (THUMB_MIN_AGE_DAYS in db.ts) stops immature videos
 * from distorting the ranking. This is the other end: a MAXIMUM age,
 * because a channel that changed its thumbnail style at some point will
 * otherwise have its old look and its new one averaged together into a
 * profile that matches neither -- exactly the client complaint this
 * feature exists to fix.
 *
 * The right window is channel-specific (a recent rebrand needs a tight
 * one, a channel that's looked the same for years doesn't), so it's a
 * per-channel setting (`getThumbnailStyleWindowSetting` /
 * `setThumbnailStyleWindowMonths` in db.ts) rather than a fixed constant.
 * This is just the menu of choices offered for it.
 */
export const STYLE_WINDOW_OPTIONS: { months: number | null; label: string }[] = [
  { months: 6, label: "Last 6 months" },
  { months: 12, label: "Last 12 months" },
  { months: 24, label: "Last 24 months" },
  { months: null, label: "All time" },
];

/**
 * Default for a channel that hasn't chosen a window yet.
 *
 * 24 months is a deliberate middle ground: tight enough that a channel
 * which rebranded a year or two back won't have its retired look still
 * outvoting the current one, but wide enough that a small or
 * slow-posting channel -- one video every month or two is common here --
 * still has a real pool of mature, proven winners to learn from instead
 * of being starved down to a couple of images. Existing installs had no
 * window at all (effectively "all time"), so this default is the
 * generous end of the new options rather than the tightest one, to avoid
 * silently shrinking anyone's reference set out from under them.
 */
export const DEFAULT_STYLE_WINDOW_MONTHS: number | null = 24;

/**
 * Below this many usable thumbnails (own + competitor combined), a
 * "style profile" is a guess wearing a lab coat, not a pattern. Rather
 * than build one anyway, `selectThumbnailWindow` widens the window a
 * step at a time until either this floor is cleared or "all time" is
 * reached; if even "all time" doesn't clear it, the caller refuses
 * outright and says exactly how many were found.
 */
export const STYLE_WINDOW_STARVATION_FLOOR = 3;

export type ThumbnailWindowSelection = {
  own: ThumbnailWinner[];
  competitor: ThumbnailWinner[];
  /** The window actually used, after any auto-widening. */
  windowMonths: number | null;
  /** What was asked for, before widening. */
  requestedWindowMonths: number | null;
  widened: boolean;
};

/**
 * Picks the winner lists for a style analysis, auto-widening the window
 * if the requested one starves the pool (see
 * STYLE_WINDOW_STARVATION_FLOOR). Own-channel and competitor selections
 * always use the same window so both describe the same era of the
 * channel's look.
 */
export function selectThumbnailWindow(
  channelId: string,
  requestedMonths: number | null
): ThumbnailWindowSelection {
  // Snap to the narrowest offered window that is still at least as wide as
  // what was asked for, rather than requiring an exact match. An unmatched
  // value used to fall back to the whole list, which starts at 6 months --
  // so asking for a very wide window got you the narrowest one, silently.
  // The UI only ever sends a listed value, but the API takes anything, and
  // being quietly stricter than requested is the worst way to be wrong here.
  const startIdx =
    requestedMonths === null
      ? STYLE_WINDOW_OPTIONS.findIndex((o) => o.months === null)
      : STYLE_WINDOW_OPTIONS.findIndex(
          (o) => o.months === null || o.months >= requestedMonths
        );
  const sequence =
    startIdx >= 0 ? STYLE_WINDOW_OPTIONS.slice(startIdx) : STYLE_WINDOW_OPTIONS;

  let own: ThumbnailWinner[] = [];
  let competitor: ThumbnailWinner[] = [];
  let usedMonths: number | null = requestedMonths;

  for (const opt of sequence) {
    own = listOwnThumbnailWinners(channelId, MAX_OWN_REFS, opt.months);
    competitor = listCompetitorThumbnailWinners(
      channelId,
      MAX_COMPETITOR_REFS,
      opt.months
    );
    usedMonths = opt.months;
    if (own.length + competitor.length >= STYLE_WINDOW_STARVATION_FLOOR) break;
    if (opt.months === null) break; // nothing wider left to try
  }

  return {
    own,
    competitor,
    windowMonths: usedMonths,
    requestedWindowMonths: requestedMonths,
    widened: usedMonths !== requestedMonths,
  };
}

export type StyleTrait = {
  summary: string;
  n: number;
  evidence: string[];
};

/** The visual traits of ONE look. Also the shape of the legacy profile. */
export type StyleTraits = {
  composition: StyleTrait & { textZone: TextZone };
  palette: StyleTrait & { dominant: string[] };
  subject: StyleTrait & { facePresent: boolean; recurringElement: string | null };
  textTreatment: StyleTrait & {
    wordCountBand: string;
    uppercase: boolean;
    stroke: boolean;
    shadow: boolean;
    /** True when the headline sits on a solid banner rather than the picture. */
    plate: boolean;
    plateColor: string | null;
    textColor: string | null;
  };
  mood: StyleTrait;
};

/**
 * One distinct look that works on this channel.
 *
 * Channels rarely have exactly one. A channel that wins with BOTH a
 * face-and-reaction cover AND a clean landscape-with-big-text cover has
 * two working formats, and the old single-profile shape forced the model
 * to describe what those two "share" — which is either nothing or the
 * bland average of both. That average is what people meant when they
 * said the generated covers came out generic.
 */
export type StyleFormat = StyleTraits & {
  /** Short human name, e.g. "Face + shock reaction". */
  label: string;
  /** Video ids this look was read from. */
  evidence: string[];
  /** Too few images to call it a rule — shown, but flagged. */
  lowConfidence: boolean;
};

/**
 * One instruction from the channel playbook.
 *
 * `strength` is the honest half. "proven" means the winners have this
 * and the underperformers largely do not; "worth-testing" means it is a
 * hypothesis, including the very common case where the whole channel
 * does it and so it explains nothing. The UI colours the two
 * differently, because a rule that cannot fail its own test is worse
 * than no rule — the owner rebuilds his covers around a coincidence.
 *
 * `psychology` is what the client asked for in as many words: not what
 * the picture looks like, but what it promises the viewer in the half
 * second before the click.
 */
export type PlaybookRule = {
  rule: string;
  evidence: string;
  strength: "proven" | "worth-testing";
  psychology: string;
};

export type ThumbnailStyleProfile = StyleTraits & {
  /**
   * One paragraph naming what this channel's cover system is, and what
   * separates its winners from the rest. Shown first so the owner can
   * catch a misread before trusting anything below it. Null on profiles
   * built before the playbook existed.
   */
  channelRead?: string | null;
  /** The playbook. Empty on profiles built before it existed. */
  rules?: PlaybookRule[];
  /**
   * Every distinct look found, strongest first. Optional because
   * profiles cached before this existed have only the flat fields; a
   * missing array means "one look", which is what those profiles are.
   *
   * `formats[0]` is always mirrored into the flat fields above, so every
   * existing reader keeps working without knowing formats exist.
   */
  formats?: StyleFormat[];
  avoid: string[];
  caveats: string[];
};

export type ReferenceThumbnail = {
  videoId: string;
  title: string;
  multiplier: number;
  /**
   * `own_loser` images exist ONLY to be shown to the analysis as the
   * control group. They must never reach the image model as style
   * references — that is the difference between "learn what fails" and
   * "copy what fails".
   */
  source: "own" | "competitor" | "own_loser";
  sourceLabel: string;
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  /** The URL the image actually came from — kie.ai needs URLs, not bytes. */
  sourceUrl: string;
};

/* ------------------------------------------------------------------ *
 * Reference images
 * ------------------------------------------------------------------ */

function refsDir(channelId: string): string {
  return path.join(DATA_DIR, "thumbnails", "_refs", safeSegment(channelId));
}

/** Keeps a channel id from ever escaping its folder. */
export function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

function mediaTypeFor(
  contentType: string | null
): "image/jpeg" | "image/png" | "image/webp" {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type === "image/png") return "image/png";
  if (type === "image/webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Download a winner's thumbnail, caching it on disk. Cached because the
 * same handful of images is read by both the analysis pass and every
 * later generation run, and YouTube's image CDN doesn't need the traffic.
 *
 * Tries the maxres file first and falls back to the stored URL — maxres
 * is absent for a good share of older videos and returns a 404 rather
 * than a smaller image.
 */
async function fetchThumbnail(
  channelId: string,
  videoId: string,
  url: string
): Promise<{
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sourceUrl: string;
}> {
  const dir = refsDir(channelId);
  fs.mkdirSync(dir, { recursive: true });
  const cached = path.join(dir, `${safeSegment(videoId)}.img`);
  const metaFile = `${cached}.type`;
  const urlFile = `${cached}.url`;

  if (fs.existsSync(cached) && fs.existsSync(metaFile)) {
    return {
      bytes: fs.readFileSync(cached),
      mimeType: mediaTypeFor(fs.readFileSync(metaFile, "utf8")),
      // Which candidate URL actually worked is cached too, so a later
      // run that needs the URL (kie.ai) doesn't have to re-probe.
      sourceUrl: fs.existsSync(urlFile)
        ? fs.readFileSync(urlFile, "utf8")
        : url,
    };
  }

  const candidates = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    url,
  ];
  let lastError = "no candidate URL succeeded";
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate);
      if (!res.ok) {
        lastError = `HTTP ${res.status} for ${candidate}`;
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      const mimeType = mediaTypeFor(res.headers.get("content-type"));
      fs.writeFileSync(cached, bytes);
      fs.writeFileSync(metaFile, mimeType);
      fs.writeFileSync(urlFile, candidate);
      return { bytes, mimeType, sourceUrl: candidate };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`could not fetch a thumbnail for ${videoId}: ${lastError}`);
}

export type CollectProgress = (done: number, total: number) => void;

/**
 * Downloads a given pair of winner lists, image bytes and all. Individual
 * download failures are skipped rather than aborting — one dead CDN
 * entry must not cost the user the whole analysis.
 */
async function downloadWinners(
  channelId: string,
  winners: {
    own: ThumbnailWinner[];
    competitor: ThumbnailWinner[];
    ownLosers?: ThumbnailWinner[];
  },
  onProgress?: CollectProgress
): Promise<{
  own: ReferenceThumbnail[];
  competitor: ReferenceThumbnail[];
  ownLosers: ReferenceThumbnail[];
}> {
  const ownLosers = winners.ownLosers ?? [];
  const total = winners.own.length + winners.competitor.length + ownLosers.length;
  let done = 0;

  const load = async (
    list: ThumbnailWinner[],
    source: ReferenceThumbnail["source"]
  ): Promise<ReferenceThumbnail[]> => {
    const out: ReferenceThumbnail[] = [];
    for (const w of list) {
      if (w.thumbnailUrl) {
        try {
          const { bytes, mimeType, sourceUrl } = await fetchThumbnail(
            channelId,
            w.videoId,
            w.thumbnailUrl
          );
          out.push({
            videoId: w.videoId,
            title: w.title,
            multiplier: w.multiplier,
            source,
            sourceLabel: w.sourceLabel,
            bytes,
            mimeType,
            sourceUrl,
          });
        } catch (err) {
          log.warn("thumbnails", "Reference thumbnail download failed", {
            videoId: w.videoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      done++;
      onProgress?.(done, total);
    }
    return out;
  };

  return {
    own: await load(winners.own, "own"),
    competitor: await load(winners.competitor, "competitor"),
    ownLosers: await load(ownLosers, "own_loser"),
  };
}

/**
 * Winners plus their image bytes for the GENERATION path (weaving
 * references into a new cover's prompt).
 *
 * `windowMonths` defaults to `null` (all time) so any caller that still
 * invokes this with just a channel id — the historical signature — gets
 * the historical behaviour, unchanged. `thumbnail-generate.ts` passes the
 * SAME window the channel's saved style profile was built with, so the
 * pictures hand-fed to the image model can never disagree with the
 * profile describing them: a profile built from the last 6 months has no
 * business handing the model a reference photo from three years ago.
 */
export async function collectReferenceThumbnails(
  channelId: string,
  windowMonths: number | null = null,
  onProgress?: CollectProgress
): Promise<{ own: ReferenceThumbnail[]; competitor: ReferenceThumbnail[] }> {
  return downloadWinners(
    channelId,
    {
      own: listOwnThumbnailWinners(channelId, MAX_OWN_REFS, windowMonths),
      competitor: listCompetitorThumbnailWinners(
        channelId,
        MAX_COMPETITOR_REFS,
        windowMonths
      ),
    },
    onProgress
  );
}

/**
 * Downloads exactly the winner lists `selectThumbnailWindow` picked.
 * Kept separate from `collectReferenceThumbnails` above so the style
 * route and the generation path can't drift apart by accident: the style
 * route must download the SAME list it reported counts for (including
 * any auto-widening), not re-query and risk a different answer.
 */
export async function collectReferenceThumbnailsForWindow(
  channelId: string,
  winners: {
    own: ThumbnailWinner[];
    competitor: ThumbnailWinner[];
    /** The control group. Analysis only — never sent to the image model. */
    ownLosers?: ThumbnailWinner[];
  },
  onProgress?: CollectProgress
): Promise<{
  own: ReferenceThumbnail[];
  competitor: ReferenceThumbnail[];
  ownLosers: ReferenceThumbnail[];
}> {
  return downloadWinners(channelId, winners, onProgress);
}

/* ------------------------------------------------------------------ *
 * Vision analysis
 * ------------------------------------------------------------------ */

/**
 * What the channel's own winners were ranked on.
 *
 * This is not cosmetic. Views say the topic worked and the algorithm
 * distributed it; click-through says the PICTURE worked. Telling the
 * model "these beat their channel's median CTR" when they were actually
 * picked by views would be a false claim about the evidence, and every
 * trait it then reports would inherit that false claim.
 *
 * Competitors are always views-based — nobody can see another channel's
 * click-through — so when the two sources differ the labels differ too,
 * per image, rather than being flattened into one sentence.
 */
export type WinnerBasis = "ctr" | "views";

function analysisInstructions(ownBasis: WinnerBasis, loserCount: number): string {
  const ownClause =
    ownBasis === "ctr"
      ? `The OWN CHANNEL images are PROVEN to outperform their channel's median CLICK-THROUGH RATE — the share of people who clicked after being shown the cover. That is direct evidence about the image itself.
The COMPETITOR images are ranked by views against their own channel's median, because click-through is private to a channel's owner. Treat a competitor trait as weaker evidence than the same trait on an own-channel image.`
      : `These thumbnails are PROVEN to outperform their channel's median VIEWS. Views are an indirect signal for a cover: they also reflect the topic and how the algorithm distributed the video. Do not claim an image "gets clicks" — say it appears on videos that outperformed.`;

  const loserClause =
    loserCount > 0
      ? `

THE CONTROL GROUP — this is what makes your answer worth reading.

${loserCount} of these images are labelled UNDERPERFORMED. They are from the SAME channel and they did WORSE than its median. They are not examples to copy; they are the test for every claim you want to make.

Before you state that a trait is why the winners won, look for it in the underperformers. If it is there too, it is the channel's HABIT, not its advantage — say so plainly and mark that rule "worth-testing", not "proven". Only a trait that is common in the winners and rare or absent in the underperformers may be called "proven".

If the winners and the underperformers genuinely look the same, SAY THAT. "These covers are built the same way; the difference between the winners and the rest is the subject and the promise, not the design" is a correct and useful answer. Inventing a visual difference that is not there is the one failure that matters here, because every generated cover afterwards inherits it.`
      : `

There is no control group in this set — only winners. That limits you: you can describe what these covers DO, but you cannot know which of it is why they won. Mark every rule "worth-testing" unless a trait is so strong and so consistent that its absence would obviously break the channel's identity.`;

  return `You are analysing YouTube thumbnails from one channel. Your job is to identify the distinct visual FORMATS at work and to write a short PLAYBOOK the channel's owner can act on — not to praise them, not to invent a brand strategy.

${ownClause}${loserClause}

Each image is labelled with its multiplier and with the metric that multiplier is measured in. Higher multiplier = stronger evidence.

MOST IMPORTANT INSTRUCTION — read this twice:

A channel usually has MORE THAN ONE cover that works. A face with a big reaction and a clean wide landscape with huge text can BOTH win on the same channel. They are two different formats, not one blurry average of the two.

Do NOT flatten them together. Do NOT describe "what they share" if what they share is only generic (bold text, high contrast, a subject in frame) — that description is useless and produces bland covers.

Instead: group these images into ${MIN_FORMATS}-${MAX_FORMATS} distinct formats, strongest first. Judge a format by how DIFFERENT it is from the others in composition, subject treatment and typography — not by topic. If every image genuinely is one look, return exactly one format and say so; forcing a second one would be just as wrong as flattening.

Rules you must follow:
- Describe only what you can SEE in these specific images.
- A format needs at least ${MIN_FORMAT_EVIDENCE} images. Images that fit no format go in "caveats", never into a format they don't belong to.
- Every format lists the video ids it was read from in its own "evidence". Every trait also lists its supporting ids, and "n" must equal that list's length.
- A trait supported by fewer than ${MIN_WINNERS} images across the whole set belongs in "caveats", not stated as a channel-wide rule.
- Do not name any specific video's subject matter as a rule. You are extracting visual GRAMMAR (composition, colour, typography, subject scale, mood), not topics.
- "label" is a short human name for the format, 2-5 words, describing the LOOK — e.g. "Face + shock reaction", "Wide landscape, huge text". Never a topic.
- Write in plain English. This gets shown to the channel owner.

THE PLAYBOOK — "channelRead" and "rules".

"channelRead" is one short paragraph in plain English naming what this channel's cover system actually is, and what separates its winners from its underperformers. The owner reads this first to check you understood his channel at all; if you got it wrong he stops there instead of trusting the rules below. Write it for a person, not for a model.

"rules" are 4-8 instructions the owner can follow on his next cover. Each one:
- "rule": what to DO, in the imperative, specific enough to act on. "Keep the headline to 2-3 words on a black band across the top quarter" — not "use clear typography".
- "evidence": where you saw it, naming the images. Say which winners have it and whether the underperformers have it too. This sentence is what makes the rule believable, so no vague "most thumbnails".
- "strength": "proven" only when the winners have it and the underperformers largely do not. Otherwise "worth-testing". Be strict — a channel-identity habit shared by everything is never "proven".
- "psychology": what this makes a viewer FEEL or expect in the half-second before they click — the promise, the curiosity gap, the threat, the number, the recognisable face. One sentence. This is the part the owner cannot get from looking at the pictures himself, so do not skip it and do not restate the visual.

Return ONLY a JSON object, no prose and no code fence, in exactly this shape:

{
  "channelRead": string,
  "rules": [
    { "rule": string, "evidence": string, "strength": "proven"|"worth-testing", "psychology": string }
  ],
  "formats": [
    {
      "label": string,
      "evidence": string[],
      "composition": { "summary": string, "textZone": "top-left"|"top-center"|"top-right"|"left"|"center"|"right"|"bottom-left"|"bottom-center"|"bottom-right", "n": number, "evidence": string[] },
      "palette": { "summary": string, "dominant": string[], "n": number, "evidence": string[] },
      "subject": { "summary": string, "facePresent": boolean, "recurringElement": string|null, "n": number, "evidence": string[] },
      "textTreatment": { "summary": string, "wordCountBand": string, "uppercase": boolean, "stroke": boolean, "shadow": boolean, "plate": boolean, "plateColor": string|null, "textColor": string|null, "n": number, "evidence": string[] },
      "mood": { "summary": string, "n": number, "evidence": string[] }
    }
  ],
  "avoid": string[],
  "caveats": string[]
}

"dominant" is 2-4 hex colours. "textZone" is where the headline sits in most of them. "wordCountBand" is like "2-3" or "4-6".

"avoid" is the mistakes list, and it is the most useful thing you will write. Each entry is ONE sentence containing both the mistake and the proof, in this shape: "<what not to do> — as in <which underperformer>, where <what actually went wrong>". Take these from the UNDERPERFORMED images wherever you can; only fall back to "what the winners never do" when there is no control group. Never write a generic don't ("avoid clutter") — a sentence that would fit any channel on YouTube helps nobody.

"plate" is true when the headline sits on a solid colour block or banner rather than directly on the picture; "plateColor" is that block's hex colour and "textColor" the letters' hex colour. Both null when there is no plate. Look carefully: a banner behind the words is one of the strongest things a channel repeats, and getting it wrong makes every generated cover look like a different channel.`;
}

export async function analyseThumbnailStyle(input: {
  analyser: AnalysisProvider;
  own: ReferenceThumbnail[];
  competitor: ReferenceThumbnail[];
  /**
   * Same channel, below its own median. The control group: without it
   * the model can only report the channel's habits back as its winning
   * formula. Optional so older callers keep working.
   */
  ownLosers?: ReferenceThumbnail[];
  /** What the OWN winners were ranked on. Competitors are always views. */
  ownBasis?: WinnerBasis;
}): Promise<{ profile: ThumbnailStyleProfile; model: string }> {
  const losers = input.ownLosers ?? [];
  const all = [...input.own, ...input.competitor, ...losers];
  if (all.length === 0) {
    throw new Error(
      "No thumbnails to analyse — sync this channel's videos first, and add competitors on the Competitors tab."
    );
  }

  if (isDryRun()) {
    return {
      profile: dryRunProfile({
        ownIds: input.own.map((r) => r.videoId),
        competitorIds: input.competitor.map((r) => r.videoId),
      }),
      model: "dry-run",
    };
  }

  const ownBasis: WinnerBasis = input.ownBasis ?? "views";

  const content: Anthropic.MessageParam["content"] = [];
  for (const ref of all) {
    // The metric is stated per image, not once at the top: on a CTR run
    // the own-channel images are click-through multiples while the
    // competitor images are still view multiples, and a single blanket
    // sentence would misdescribe half the evidence.
    const isOwn = ref.source === "own" || ref.source === "own_loser";
    const metric = isOwn && ownBasis === "ctr" ? "median CTR" : "median views";
    const who =
      ref.source === "own"
        ? "OWN CHANNEL — WINNER"
        : ref.source === "own_loser"
          ? "OWN CHANNEL — UNDERPERFORMED"
          : `COMPETITOR: ${ref.sourceLabel}`;
    content.push({
      type: "text",
      text: `[${ref.videoId}] ${who} — ${ref.multiplier.toFixed(2)}x its channel ${metric} — "${ref.title}"`,
    });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: ref.mimeType,
        data: ref.bytes.toString("base64"),
      },
    });
  }
  content.push({ type: "text", text: analysisInstructions(ownBasis, losers.length) });

  const raw = await runTurn({
    analyser: input.analyser,
    content,
    // Generous: the profile JSON runs long, and truncation lands as a
    // JSON parse error rather than a clean failure. Sonnet 5 is more
    // verbose than the model this budget was first tuned against.
    maxTokens: 8000,
    label: "thumbnail style analysis",
  });

  return {
    profile: normaliseProfile(parseJsonObject(raw)),
    model: input.analyser.model,
  };
}

/**
 * One non-streaming turn against whichever provider is configured.
 *
 * Goes through `ai-provider.ts` rather than the Anthropic SDK directly,
 * which is what lets a free Gemini key drive this feature. That adapter
 * already converts Anthropic-shaped image blocks into Gemini's
 * inlineData at the SDK boundary, so the caller builds one message shape
 * and neither branch has to know about the other.
 */
async function runTurn(opts: {
  analyser: AnalysisProvider;
  content: Anthropic.MessageParam["content"];
  maxTokens: number;
  label: string;
}): Promise<string> {
  const started = Date.now();
  const result = await streamTurn({
    provider: opts.analyser.provider,
    apiKey: opts.analyser.apiKey,
    system:
      "You analyse YouTube thumbnails and return strict JSON. Never wrap the JSON in a code fence.",
    messages: [{ role: "user", content: opts.content }],
    tools: [],
    maxTokens: opts.maxTokens,
    // Nothing consumes the stream here; we want the final text. The
    // callback is required by the interface.
    onText: () => {},
  });

  recordAnalysisUsage(result.usage, opts.analyser.model, started, opts.label);

  const text = result.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text.trim()) {
    throw new Error(
      `${opts.analyser.model} returned no text for the ${opts.label}. It may have refused the request.`
    );
  }
  return text;
}

/**
 * The model returns JSON, but a stray code fence or a leading sentence
 * shouldn't cost the user a paid call. Take the outermost braces.
 */
function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("The style analysis did not return JSON.");
  }
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * Defensive normalisation. Every field is coerced to the shape the UI
 * renders, and `n` is recomputed from the evidence array rather than
 * trusted — a model that claims n=9 while listing three ids would
 * otherwise turn a caveat into a rule.
 */
/**
 * A hex colour the canvas can actually use, or null. Models answer this
 * field with "red" or "n/a" as often as with a hex value, and a bad
 * fillStyle silently paints black rather than throwing.
 */
function hexOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
}

/**
 * Normalise one look's traits.
 *
 * Takes the same object shape whether it came from a format entry or
 * from a pre-formats profile — which is what lets an old cached profile
 * and a new multi-format one go through identical code.
 */
function normaliseTraits(raw: Record<string, unknown>): StyleTraits {
  const trait = (key: string): StyleTrait => {
    const t = (raw[key] ?? {}) as Record<string, unknown>;
    const evidence = Array.isArray(t.evidence)
      ? (t.evidence as unknown[]).map(String)
      : [];
    return {
      summary: typeof t.summary === "string" ? t.summary : "",
      evidence,
      n: evidence.length,
    };
  };

  const composition = raw.composition as Record<string, unknown> | undefined;
  const palette = raw.palette as Record<string, unknown> | undefined;
  const subject = raw.subject as Record<string, unknown> | undefined;
  const textTreatment = raw.textTreatment as Record<string, unknown> | undefined;

  return {
    composition: { ...trait("composition"), textZone: coerceZone(composition?.textZone) },
    palette: {
      ...trait("palette"),
      dominant: Array.isArray(palette?.dominant)
        ? (palette!.dominant as unknown[]).map(String).slice(0, 4)
        : [],
    },
    subject: {
      ...trait("subject"),
      facePresent: subject?.facePresent === true,
      recurringElement:
        typeof subject?.recurringElement === "string"
          ? (subject.recurringElement as string)
          : null,
    },
    textTreatment: {
      ...trait("textTreatment"),
      wordCountBand:
        typeof textTreatment?.wordCountBand === "string"
          ? (textTreatment.wordCountBand as string)
          : "2-3",
      uppercase: textTreatment?.uppercase !== false,
      stroke: textTreatment?.stroke !== false,
      shadow: textTreatment?.shadow !== false,
      plate: textTreatment?.plate === true,
      plateColor: hexOrNull(textTreatment?.plateColor),
      textColor: hexOrNull(textTreatment?.textColor),
    },
    mood: trait("mood"),
  };
}

/**
 * The playbook half of the answer: instructions the owner can act on,
 * each carrying its own proof and its own confidence.
 *
 * Kept separate from the trait tables because they answer different
 * questions. Traits describe what the covers LOOK like and feed the
 * image model; rules say what to DO next and are written for the person.
 * The trait table was the whole product until a client said he could not
 * tell what to change after reading it.
 */
function normaliseRules(raw: unknown): PlaybookRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PlaybookRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const rule = typeof o.rule === "string" ? o.rule.trim() : "";
    // A rule with no instruction in it is not a rule. Dropping it is
    // better than rendering an empty bullet that reads as a UI bug.
    if (!rule) continue;
    out.push({
      rule,
      evidence: typeof o.evidence === "string" ? o.evidence.trim() : "",
      // Anything the model didn't explicitly mark as proven is a
      // hypothesis. Defaulting the other way would turn a parsing slip
      // into a false claim of evidence, which is the one thing this
      // whole feature exists to avoid.
      strength: o.strength === "proven" ? "proven" : "worth-testing",
      psychology: typeof o.psychology === "string" ? o.psychology.trim() : "",
    });
  }
  return out.slice(0, MAX_RULES);
}

function normaliseProfile(raw: Record<string, unknown>): ThumbnailStyleProfile {
  const avoid = Array.isArray(raw.avoid) ? (raw.avoid as unknown[]).map(String) : [];
  const caveats = Array.isArray(raw.caveats)
    ? (raw.caveats as unknown[]).map(String)
    : [];
  const channelRead =
    typeof raw.channelRead === "string" && raw.channelRead.trim()
      ? (raw.channelRead as string).trim()
      : null;
  const rules = normaliseRules(raw.rules);

  const rawFormats = Array.isArray(raw.formats)
    ? (raw.formats as unknown[]).filter(
        (f): f is Record<string, unknown> => !!f && typeof f === "object"
      )
    : [];

  // No formats key at all = a model that answered in the old shape, or an
  // old cached profile being re-normalised. Treat the object itself as
  // the single format rather than losing everything it did return.
  if (rawFormats.length === 0) {
    return { ...normaliseTraits(raw), avoid, caveats, channelRead, rules };
  }

  const formats: StyleFormat[] = rawFormats
    .map((f, i) => {
      const evidence = Array.isArray(f.evidence)
        ? (f.evidence as unknown[]).map(String)
        : [];
      return {
        ...normaliseTraits(f),
        label:
          typeof f.label === "string" && f.label.trim()
            ? (f.label as string).trim()
            : `Format ${i + 1}`,
        evidence,
        // Two different bars, and mixing them up hides exactly the
        // formats that need the warning most: MIN_FORMAT_EVIDENCE is
        // what it takes to EXIST as a format at all, while MIN_WINNERS
        // is what it takes to be called PROVEN. A format sitting between
        // the two is real enough to show and thin enough to flag — and a
        // format sitting exactly on the lower floor is the thinnest
        // thing on screen, so it must never come through unflagged.
        lowConfidence: evidence.length < MIN_WINNERS,
      };
    })
    // Strongest first by how many images back it. The model is asked for
    // this order already; sorting makes it true rather than hoped-for,
    // because formats[0] is what fills the flat fields below and what
    // generation defaults to.
    .sort((a, b) => b.evidence.length - a.evidence.length)
    .slice(0, MAX_FORMATS);

  // Mirror the strongest format into the flat fields. Everything written
  // before formats existed — the generation prompt, the overlay
  // defaults, the panel — reads those and keeps working untouched.
  return { ...formats[0], formats, avoid, caveats, channelRead, rules };
}

/* ------------------------------------------------------------------ *
 * Prompt construction
 * ------------------------------------------------------------------ */

export type GenerationPlan = {
  prompt: string;
  overlayCandidates: string[];
  zone: TextZone;
};

/**
 * The profile as ONE format, for handing to the prompt writer.
 *
 * The whole point of finding several formats is undone if all of them go
 * into the prompt together — the model would blend them right back into
 * the average we just stopped producing. So a generation run commits to
 * one look, and the prompt writer never learns the others exist.
 *
 * Out-of-range or missing index falls back to the strongest format,
 * which is also exactly what a pre-formats profile yields.
 */
/**
 * Reads the owner's note as a list of panels when it is one.
 *
 * Deliberately forgiving about the marker — people type "1.", "1)",
 * "-", "•" or nothing at all — and deliberately strict about the count:
 * two lines are a sentence that happened to wrap, not a list. Returns an
 * empty array for ordinary prose, which leaves the note being passed
 * through as a plain remark exactly as before.
 */
export function parseListItems(note: string | null | undefined): string[] {
  if (!note) return [];
  const lines = note
    .split(/\r?\n|(?<=[^\d])\s(?=\d{1,2}[.)]\s)/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\s*(?:\d{1,2}[.)]|[-*•])\s*/, "").trim())
    .filter(Boolean);
  // Every line being one word is a shopping list of adjectives, not
  // panels; fewer than three is not a list at all.
  return lines.length >= 3 ? lines : [];
}

export function profileForFormat(
  profile: ThumbnailStyleProfile,
  formatIndex?: number | null
): { profile: ThumbnailStyleProfile; label: string | null; index: number } {
  const formats = profile.formats;
  if (!formats || formats.length === 0) {
    return { profile: { ...profile, formats: undefined }, label: null, index: 0 };
  }
  const i =
    typeof formatIndex === "number" && formatIndex >= 0 && formatIndex < formats.length
      ? formatIndex
      : 0;
  const chosen = formats[i];
  return {
    profile: {
      composition: chosen.composition,
      palette: chosen.palette,
      subject: chosen.subject,
      textTreatment: chosen.textTreatment,
      mood: chosen.mood,
      // Avoid/caveats/playbook are channel-wide, not per-format — they
      // still apply whichever look is being built.
      avoid: profile.avoid,
      caveats: profile.caveats,
      channelRead: profile.channelRead ?? null,
      rules: profile.rules ?? [],
      formats: undefined,
    },
    label: chosen.label,
    index: i,
  };
}

const PROMPT_INSTRUCTIONS = `You write prompts for an image generation model that will produce a YouTube thumbnail BACKGROUND, plus the short headline that will be composited on top of it afterwards.

Critical constraints:
- The reference images fall into two kinds and they are NOT to be treated the same way. Say both of these explicitly in the prompt whenever brand assets are present.
  - CHANNEL references (this channel's own and its competitors' thumbnails): DERIVE the visual grammar from them — composition, palette, mood, treatment. Do NOT reproduce any one of them: not its subject, not its layout, not its specific scene.
  - BRAND references (a character, mascot, logo or frame the owner uploaded): the opposite. REPRODUCE the supplied brand character as the same individual — same face, hair, clothing and proportions — and the supplied logo or frame as the same graphic. It may be re-posed, re-lit and placed anywhere the composition needs, but it must be recognisably the same one, not a person "in that style".
  - Where the two disagree, the brand reference wins on WHO or WHAT is depicted, and the channel references win on HOW it is depicted.
- The image must contain NO TEXT, NO LETTERING, NO WATERMARKS and no logos. The headline is added later by a separate renderer. State this in the prompt.
- Leave the headline zone visually calm — no busy detail there — so overlaid text stays readable.
- Write the headline candidates in the channel's own language, shown by the sample titles you are given. The subject matter is irrelevant to this: a video about Norway on an English channel still gets an English headline. Never translate the channel's language into another one.
- If the profile names a recurring non-text graphic element (an arrow, a frame, a marker), include it in the prompt. It is not text and it is part of why these covers work.

Return ONLY a JSON object, no prose and no code fence:

{
  "prompt": string,
  "overlayCandidates": [string, string, string],
  "zone": "top-left"|"top-center"|"top-right"|"left"|"center"|"right"|"bottom-left"|"bottom-center"|"bottom-right"
}

"prompt" is one paragraph, concrete and visual. "overlayCandidates" are three headline options for the thumbnail, each within the channel's observed word-count band — punchy, not a restatement of the full title. "zone" is where the headline should sit.`;

/**
 * The frame constraint the prompt has to carry. A Shorts cover is not a
 * cropped video cover: the subject has to be readable in a tall frame on
 * a phone, and the same style profile has to be re-composed for it
 * rather than reproduced.
 */
const ASPECT_INSTRUCTIONS: Record<AspectChoice, string> = {
  "16:9":
    "- Aspect ratio is 16:9 (landscape), and the composition must survive being viewed at 210x118 pixels.",
  "9:16":
    "- Aspect ratio is 9:16 (tall vertical, a YouTube Shorts cover), and the composition must survive being viewed at 118x210 pixels on a phone. Re-compose the channel's visual grammar for a tall frame: a single subject stacked centrally with generous headroom, not a landscape scene cropped.",
};

export async function buildGenerationPlan(input: {
  analyser: AnalysisProvider;
  profile: ThumbnailStyleProfile;
  title: string;
  /** Defaults to 16:9 when the caller doesn't care. */
  aspect?: AspectChoice;
  /** Real titles from this channel, as evidence of its language. */
  channelTitles?: string[];
  userNote?: string | null;
  brandAssetDescriptions: string[];
  headlineZone?: TextZone;
  /** True when the bundled font can't render this script, so the image
   *  model has to draw the text itself. Changes the prompt materially. */
  modelRendersText: boolean;
  /** Which of the channel's looks to build for. Defaults to the strongest. */
  formatIndex?: number | null;
}): Promise<GenerationPlan> {
  // Commit to a single look before anything else reads the profile.
  const picked = profileForFormat(input.profile, input.formatIndex);
  const profile = picked.profile;

  if (isDryRun()) {
    return {
      prompt: dryRunPrompt(input.title),
      overlayCandidates: [input.title],
      zone: input.headlineZone ?? profile.composition.textZone,
    };
  }

  // Only ever announced when the assets will actually be sent to the image
  // model. Telling the prompt writer that a character exists when the
  // selected provider silently drops it produces a prompt that instructs
  // the model to reproduce a picture it was never given — which reads as
  // the model ignoring the character, and cost a client a run to discover.
  const brandLine = input.brandAssetDescriptions.length
    ? `The channel owner supplies these BRAND references, and they are attached to the image request: ${input.brandAssetDescriptions.join(
        "; "
      )}. These are not style examples — they are the actual character/graphic that must appear. Instruct the image model, in the prompt, to reproduce the supplied brand character as the same individual (same face, hair, clothing, proportions) rather than inventing someone who merely fits the channel's style. Everything else about the image still follows the channel style profile.`
    : "The channel supplies no brand assets, so every subject is derived from the style profile alone.";

  const textLine = input.modelRendersText
    ? `IMPORTANT OVERRIDE: this channel's language cannot be rendered by our text compositor, so the image model MUST draw the headline itself, spelled exactly as given. Include the exact headline text in the prompt, in quotes, and describe its treatment (${profile.textTreatment.uppercase ? "uppercase" : "sentence case"}, heavy weight, high contrast).`
    : "The image must contain no text at all.";

  // The playbook, spelled out rather than left inside the JSON dump
  // below. The rules are the part written for a human, and burying them
  // in a serialised object next to hex codes is how they get skimmed.
  // Proven and worth-testing are stated differently on purpose: a
  // hypothesis presented as a requirement is how a coincidence becomes
  // every cover this channel makes from now on.
  const proven = (profile.rules ?? []).filter((r) => r.strength === "proven");
  const testing = (profile.rules ?? []).filter((r) => r.strength !== "proven");
  const playbookLine = (profile.rules ?? []).length
    ? `CHANNEL PLAYBOOK — what this channel's covers must do${
        profile.channelRead ? `\n\nHow this channel reads: ${profile.channelRead}` : ""
      }${
        proven.length
          ? `\n\nFOLLOW THESE — they held up against the channel's own underperformers:\n${proven
              .map((r) => `- ${r.rule}${r.psychology ? ` (it works by: ${r.psychology})` : ""}`)
              .join("\n")}`
          : ""
      }${
        testing.length
          ? `\n\nPREFER THESE, but they are unproven — never break a rule above to satisfy one of these:\n${testing
              .map((r) => `- ${r.rule}`)
              .join("\n")}`
          : ""
      }${
        profile.avoid.length
          ? `\n\nDO NOT DO THESE — each one is a mistake this channel has already made:\n${profile.avoid
              .map((a) => `- ${a}`)
              .join("\n")}`
          : ""
      }`
    : "";

  // A listicle cover lives or dies on whether its tiles show ten
  // different things. Left as one free-form sentence the note reads as
  // flavour and the model draws ten variations of the same object —
  // which is exactly what clients report as "it generates rubbish".
  // Recognised as a list, it becomes the layout brief.
  const listItems = parseListItems(input.userNote);
  const noteLine = !input.userNote
    ? ""
    : listItems.length >= 3
      ? `\nTHIS IS A LIST COVER. The owner has said what each panel must show, in this order — ${listItems.length} items:
${listItems.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Build a layout that holds exactly ${listItems.length} panels, one per item, in this order. Every panel must be recognisable at thumbnail size on a phone: do not merge two items into one illustration, do not repeat the same subject across panels, and do not invent an extra one. If the channel's format labels each panel, label them from these items.`
      : `\nThe channel owner adds: ${input.userNote}`;

  const languageLine = input.channelTitles?.length
    ? `THIS CHANNEL'S OWN RECENT TITLES (these show the language to write the headline in):\n${input.channelTitles
        .map((t) => `- ${t}`)
        .join("\n")}`
    : "";

  const raw = await runTurn({
    analyser: input.analyser,
    maxTokens: 4000,
    label: "thumbnail prompt build",
    content: `VIDEO TITLE: ${input.title}

${languageLine}

CHANNEL STYLE PROFILE (derived from thumbnails that beat this channel's median)${
      picked.label
        ? ` — build for this channel's "${picked.label}" format, which is ONE of the looks that works here. Follow it; do not average it with anything else`
        : ""
    }:
${JSON.stringify(profile, null, 2)}

${playbookLine}

${brandLine}
${textLine}
${noteLine}

${PROMPT_INSTRUCTIONS}

Frame constraint for this run:
${ASPECT_INSTRUCTIONS[input.aspect ?? DEFAULT_ASPECT]}`,
  });
  const parsed = parseJsonObject(raw);

  const candidates = Array.isArray(parsed.overlayCandidates)
    ? (parsed.overlayCandidates as unknown[]).map(String).filter(Boolean)
    : [];

  return {
    prompt:
      typeof parsed.prompt === "string" && parsed.prompt.trim()
        ? parsed.prompt.trim()
        : fallbackPrompt(profile, input.title, input.aspect ?? DEFAULT_ASPECT),
    // Falling back to the raw title is better than an empty headline —
    // the user can edit it for free, and a blank cover is useless.
    overlayCandidates: candidates.length ? candidates : [input.title],
    // Where the headline goes is measured, not decided in the moment.
    //
    // This channel's winners put 2-3 words in the TOP-LEFT — the profile
    // says so with the videos to back it. The prompt writer returned
    // "bottom-left" for the same run, and the cover came out looking
    // like somebody else's channel. The model is answering about the
    // picture it just imagined; the profile is answering about twelve
    // covers that actually won. Data wins.
    //
    // The model still gets the last word in the one case where there is
    // nothing to measure: `n` is how many images supported the zone, and
    // at zero the profile's value is only `coerceZone`'s default rather
    // than an observation. An explicit choice in the UI beats both.
    zone:
      input.headlineZone ??
      (profile.composition.n > 0
        ? profile.composition.textZone
        : coerceZone(parsed.zone)),
  };
}

/** Used only when the model returns an unusable prompt field. */
function fallbackPrompt(
  profile: ThumbnailStyleProfile,
  title: string,
  aspect: AspectChoice
): string {
  return [
    aspect === "9:16"
      ? `A 9:16 vertical YouTube Shorts cover background for a video titled "${title}".`
      : `A 16:9 YouTube thumbnail background for a video titled "${title}".`,
    profile.composition.summary,
    profile.palette.summary,
    profile.subject.summary,
    profile.mood.summary,
    "Derive the visual grammar from the reference images without reproducing any single one of them.",
    "No text, no lettering, no logos, no watermarks anywhere in the image.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Thumbnail work spends the user's Claude key, so it shows up in the same
 * usage counter as everything else. sessionId is null because these calls
 * belong to no chat session; `firstUserMsg` carries the label so the
 * Integrations page can tell them apart.
 */
function recordAnalysisUsage(
  usage: UnifiedUsage,
  model: string,
  startedAt: number,
  label: string
): void {
  try {
    const inputFresh = usage.inputTokens;
    const output = usage.outputTokens;
    const inputCacheWrite = usage.cacheWriteTokens;
    const inputCacheRead = usage.cacheReadTokens;
    recordClaudeUsage({
      sessionId: null,
      executorModel: model,
      advisorModel: null,
      inputTokens: inputFresh,
      outputTokens: output,
      cacheWriteTokens: inputCacheWrite,
      cacheReadTokens: inputCacheRead,
      advisorInputTokens: 0,
      advisorOutputTokens: 0,
      advisorCalls: 0,
      costMillicents: costMillicents(model, {
        inputFresh,
        inputCacheWrite,
        inputCacheRead,
        output,
      }),
      durationMs: Date.now() - startedAt,
      iterations: 1,
      firstUserMsg: label,
      activeTools: [],
    });
  } catch (err) {
    // Usage accounting must never be the reason a generation fails.
    log.warn("thumbnails", "Could not record Claude usage", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
