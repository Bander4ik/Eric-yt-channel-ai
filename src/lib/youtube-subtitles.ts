import "server-only";
import youtubeDl from "youtube-dl-exec";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maybeWriteCookiesTempFile, ytDlpCommonFlags } from "./deepgram";

/**
 * Free transcripts from YouTube's own subtitle tracks, via yt-dlp.
 *
 * Why this exists: the app used to have exactly one way to get spoken
 * text — download the audio and pay Deepgram per audio-minute. But most
 * YouTube videos already ship a caption track that anyone can fetch for
 * nothing. Measured on a real 23-minute video from this user's channel
 * (DDXYjTosVoA):
 *
 *   subtitles : 179 KB, < 1s, no API key, $0.00
 *   audio     : ~23 MB into RAM, then billed at $0.0043/audio-minute
 *
 * So captions come FIRST everywhere and Deepgram is the fallback for
 * videos that genuinely have no captions. It also unlocks competitor
 * videos, which could never be transcribed at all (we own no audio
 * rights problem there — but we also can't afford to Deepgram 50
 * competitor videos per sync).
 *
 * yt-dlp is already a dependency (`youtube-dl-exec`) and already used by
 * deepgram.ts for audio; we deliberately reuse its `ytDlpCommonFlags()`
 * and cookies handling rather than growing a second way to invoke it.
 */

/**
 * Deliberate pause between consecutive videos in any batch/loop that
 * calls fetchSubtitleText.
 *
 * This is not superstition: while prototyping this feature, fetching four
 * language tracks of a SINGLE video in quick succession from a normal
 * residential IP got `HTTP Error 429: Too Many Requests` on the fourth.
 * YouTube's timedtext endpoint is rate-limited far more aggressively than
 * its video endpoints. 2s between videos keeps a 50-video competitor sync
 * comfortably under the limit; raise it if 429s ever reappear.
 */
export const SUBTITLE_FETCH_DELAY_MS = 2000;

/** Thrown when YouTube rate-limits us. Callers should back off, not retry. */
export class SubtitleRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtitleRateLimitError";
  }
}

/** Thrown for real failures (yt-dlp missing, video private, parse blew up). */
export class SubtitleFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtitleFetchError";
  }
}

/* ============================================================
 * The VTT parser
 * ============================================================ */

/**
 * Turn a WebVTT subtitle file into plain running text.
 *
 * YouTube serves two structurally different VTT shapes and getting this
 * wrong is silent — you get text that looks plausible but is either
 * tripled or missing half its words. Both shapes were verified against
 * real downloads.
 *
 * SHAPE 1 — auto-generated captions. Carry inline per-word timing tags
 * and a *rolling window*: each cue repeats the previous line and then
 * appends new words.
 *
 *     00:00:18.800 --> 00:00:21.790
 *     We're<00:00:19.039><c> no</c><00:00:19.359><c> strangers</c>
 *
 *     00:00:21.790 --> 00:00:21.800
 *     We're no strangers
 *
 * Concatenating every cue naively roughly triples the transcript.
 *
 * SHAPE 2 — author-written tracks. No tags at all, no rolling window;
 * every single line is real, unrepeated content.
 *
 * The trap: "keep only the lines that contain tags" is correct for shape
 * 1 and silently DROPS HALF THE WORDS on shape 2, where no line has a
 * tag. The rule below picks tagged lines only when the cue actually has
 * some, and otherwise keeps every line — which is right for both.
 *
 * Exported as a pure function so it can be tested with no network.
 */
export function vttToText(vtt: string): string {
  // Normalise line endings; VTT from YouTube is \n but be safe.
  const body = vtt.replace(/\r\n?/g, "\n");

  // Split into cues on blank lines. The WEBVTT header block and any
  // NOTE/STYLE/Kind:/Language: preamble fall out naturally below because
  // they carry no timing line and no text we keep.
  const blocks = body.split(/\n{2,}/);

  const kept: string[] = [];

  for (const block of blocks) {
    const rawLines = block.split("\n");
    // A cue must have a timing line; anything else is header/metadata.
    const timingIndex = rawLines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;

    // Per the VTT spec the payload is everything AFTER the timing line;
    // anything before it is the optional cue identifier. Dropping the
    // whole prefix matters because SRT-derived tracks put a bare cue
    // number there, which would otherwise land in the transcript as
    // stray digits.
    const lines = rawLines
      .slice(timingIndex + 1)
      .filter((l) => !l.includes("-->"))
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // What marks the NEW line of a rolling auto-caption cue is a per-WORD
    // TIMESTAMP — `<00:00:19.039>` — not any angle bracket. Treating every
    // "<" as that marker silently deleted real speech: an author-written
    // cue whose first line is `<i>whispering</i>` lost its second line
    // entirely, and so did a plain sentence containing "a < b". The
    // transcript still read fluently, so nothing looked wrong.
    const timed = lines.filter((l) => WORD_TIMESTAMP.test(l));
    const pick = timed.length > 0 ? timed : lines;

    for (const line of pick) {
      const text = stripCueMarkup(line);
      if (!text) continue;

      const last = kept[kept.length - 1];
      if (last !== undefined) {
        // Exact repeat of the previous line (the rolling window's
        // "settle" cue) — drop it.
        if (last === text) continue;
        // The previous line already ends with this one, i.e. this cue is
        // a prefix that the previous cue has fully absorbed. Drop it.
        if (last.endsWith(text)) continue;
      }
      kept.push(text);
    }
  }

  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/** Strip `<...>` timing/`<c>` tags, decode the handful of entities VTT uses. */
/** `<00:00:19.039>` — the per-word timing tag YouTube's ASR emits. */
const WORD_TIMESTAMP = /<\d{1,2}:\d{2}:\d{2}[.,]\d{3}>/;

function stripCueMarkup(line: string): string {
  return line
    // Only real cue markup: a timestamp, or an element tag like <i>, </v>,
    // <c.colorE5E5E5>. A bare "<" in speech ("a < b") is left alone — the
    // old catch-all `<[^>]*>` would have eaten "< b >" out of a sentence.
    .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{3}>/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/* ============================================================
 * Track selection — language is DATA, never a literal
 * ============================================================ */

type YtDlpSubtitleInfo = {
  language?: string | null;
  duration?: number;
  subtitles?: Record<string, unknown[]>;
  automatic_captions?: Record<string, unknown[]>;
};

/**
 * A caption track we could download.
 * `key` is the exact yt-dlp `--sub-langs` token (e.g. "en", "de-DE",
 * "en-orig"); `auto` says whether it is machine-generated.
 */
type TrackChoice = { key: string; language: string; auto: boolean };

/** "en-US" / "en-orig" → "en". Used to match a wanted language to a track key. */
function baseLang(key: string): string {
  return key.split(/[-_]/)[0].toLowerCase();
}

/**
 * Non-speech tracks yt-dlp lists alongside real subtitles. `live_chat`
 * is a JSON chat replay, not captions.
 */
const NON_CAPTION_KEYS = new Set(["live_chat"]);

/**
 * Choose which caption track to download.
 *
 * Language is NEVER hardcoded. The order of evidence:
 *
 *   1. `preferLanguage` passed by the caller — the app's own knowledge
 *      (e.g. the language a previous transcript of this video, or of
 *      another video on the same channel, was detected as).
 *   2. `info.language` — yt-dlp's report of the video's OWN original
 *      language, straight from YouTube's metadata. This is the workhorse
 *      and works for German / French / Ukrainian channels identically.
 *   3. The `-orig` auto-caption key. YouTube publishes hundreds of
 *      machine TRANSLATIONS of every auto-captioned video plus exactly
 *      one `<lang>-orig` key marking the genuine original-language ASR.
 *      Its prefix tells us the original language even when (2) is blank.
 *   4. The only author-written track, if there is exactly one.
 *
 * If none of that resolves, we return null rather than guessing — a
 * previous feature in this repo shipped a hardcoded English default and
 * became a total blackout for every non-English channel.
 *
 * Author-written tracks beat auto-generated ones for the same language:
 * real punctuation and no ASR errors.
 */
export function chooseTrack(
  info: YtDlpSubtitleInfo,
  preferLanguage?: string | null
): TrackChoice | null {
  const authorKeys = Object.keys(info.subtitles ?? {}).filter(
    (k) => !NON_CAPTION_KEYS.has(k)
  );
  const autoKeys = Object.keys(info.automatic_captions ?? {}).filter(
    (k) => !NON_CAPTION_KEYS.has(k)
  );
  if (authorKeys.length === 0 && autoKeys.length === 0) return null;

  const origKey = autoKeys.find((k) => k.toLowerCase().endsWith("-orig"));

  const candidates: string[] = [];
  const push = (v: string | null | undefined) => {
    if (!v) return;
    const b = baseLang(v);
    if (b && !candidates.includes(b)) candidates.push(b);
  };
  push(preferLanguage);            // (1) what the app already knows
  push(info.language);             // (2) the video's own original language
  push(origKey);                   // (3) the original-ASR marker
  if (authorKeys.length === 1) push(authorKeys[0]); // (4) the sole author track

  for (const want of candidates) {
    // Author track for this language wins — better punctuation.
    const author =
      authorKeys.find((k) => k.toLowerCase() === want) ??
      authorKeys.find((k) => baseLang(k) === want);
    if (author) {
      return { key: author, language: baseLang(author), auto: false };
    }
    // Then the original-language ASR track, then any auto track for it.
    const auto =
      autoKeys.find((k) => k.toLowerCase() === `${want}-orig`) ??
      autoKeys.find((k) => k.toLowerCase() === want) ??
      autoKeys.find((k) => baseLang(k) === want);
    if (auto) {
      return { key: auto, language: baseLang(auto), auto: true };
    }
  }

  return null;
}

/* ============================================================
 * The fetch
 * ============================================================ */

export type SubtitleResult = {
  text: string;
  /** Base language code of the track we actually read, e.g. "de". */
  language: string;
  /** True when the track is YouTube's machine ASR rather than author-written. */
  auto: boolean;
  /** Video length in seconds as reported by yt-dlp (0 when unknown). */
  durationSeconds: number;
};

/**
 * Fetch a YouTube video's spoken text from its subtitle track.
 *
 * Returns null when the video simply has no usable captions — that is a
 * normal, expected outcome and the caller's cue to fall back to Deepgram.
 * Throws only on real errors (yt-dlp missing/blocked, private video,
 * rate limit).
 *
 * Two yt-dlp invocations, deliberately:
 *   1. metadata only, to learn which tracks exist and what the video's
 *      own language is;
 *   2. download exactly ONE track.
 * The obvious one-call alternative (`--sub-langs all`) downloads every
 * one of the ~150 machine translations YouTube offers and is precisely
 * what triggered a 429 during prototyping.
 *
 * yt-dlp writes subtitle files to disk, so everything lands in a fresh
 * temp directory that is removed in a `finally` — nothing is left on the
 * user's machine.
 */
export async function fetchSubtitleText(
  videoId: string,
  opts: {
    /** Language the app believes this video is in. See chooseTrack. */
    preferLanguage?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<SubtitleResult | null> {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookies = maybeWriteCookiesTempFile();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-subs-"));

  try {
    const flags = ytDlpCommonFlags(cookies?.path ?? null);

    // ---- 1. What tracks does this video have, and in what language? ----
    let info: YtDlpSubtitleInfo;
    try {
      info = (await youtubeDl(ytUrl, {
        ...flags,
        dumpSingleJson: true,
        skipDownload: true,
      })) as unknown as YtDlpSubtitleInfo;
    } catch (err) {
      throw toSubtitleError(err, videoId, "listing subtitle tracks");
    }

    const track = chooseTrack(info, opts.preferLanguage);
    if (!track) return null; // no captions at all → caller falls back

    // ---- 2. Download that one track as VTT into the temp dir ----
    try {
      await youtubeDl(ytUrl, {
        ...flags,
        skipDownload: true,
        writeSub: true,
        writeAutoSub: true,
        subFormat: "vtt",
        // `--sub-lang` is yt-dlp's accepted alias for `--sub-langs`; it is
        // the spelling youtube-dl-exec's flag types know about. Verified
        // against the shipped yt-dlp binary (2026.06.09).
        subLang: track.key,
        output: path.join(tmpDir, "%(id)s.%(ext)s"),
      });
    } catch (err) {
      throw toSubtitleError(err, videoId, `downloading subtitle track "${track.key}"`);
    }

    const vttFile = fs
      .readdirSync(tmpDir)
      .find((f) => f.toLowerCase().endsWith(".vtt"));
    if (!vttFile) {
      // yt-dlp listed the track but wrote nothing — treat as "no captions"
      // rather than an error; the Deepgram fallback still gets the user
      // their transcript.
      return null;
    }

    const raw = fs.readFileSync(path.join(tmpDir, vttFile), "utf8");
    const text = vttToText(raw);
    if (!text) return null;

    return {
      text,
      language: track.language,
      auto: track.auto,
      durationSeconds: Math.round(info.duration ?? 0),
    };
  } finally {
    // Nothing may be left on the user's disk, on any exit path.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    cookies?.cleanup();
  }
}

/**
 * Normalise a yt-dlp/execa rejection into our error types. The real
 * diagnostic lives on stderr — `err.message` is frequently empty — and a
 * 429 has to be distinguishable so batch callers can stop instead of
 * hammering YouTube harder.
 */
function toSubtitleError(err: unknown, videoId: string, what: string): Error {
  const e = err as {
    message?: string;
    shortMessage?: string;
    stderr?: unknown;
    exitCode?: number;
  };
  const stderr = typeof e.stderr === "string" ? e.stderr : String(e.stderr ?? "");
  const detail =
    [e.shortMessage ?? e.message, stderr.trim() && `stderr: ${stderr.slice(-600)}`]
      .filter(Boolean)
      .join(" | ") || "(no output)";

  if (/\b429\b|too many requests/i.test(stderr) || /\b429\b/.test(detail)) {
    return new SubtitleRateLimitError(
      `YouTube rate-limited the subtitle request for ${videoId} while ${what} (HTTP 429). ` +
        `Wait a few minutes before retrying; batch runs pace themselves at ` +
        `${SUBTITLE_FETCH_DELAY_MS}ms between videos.`
    );
  }
  return new SubtitleFetchError(
    `yt-dlp failed for ${videoId} while ${what}: ${detail}`
  );
}
