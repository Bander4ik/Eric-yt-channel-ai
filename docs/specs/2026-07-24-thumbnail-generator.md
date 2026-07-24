# Thumbnail Generator — Specification

Date: 2026-07-24 · Repo: `YT-Wizards/Eric-yt-channel-ai` · Source brief: [`PROJECT-BRIEF.md`](../../PROJECT-BRIEF.md)

## Executive Summary

A new **Thumbnails** tab in the Ideation hub that turns a video title (from a Board idea, a
Signals-generated title, or manual entry) into several finished 1280×720 thumbnails whose visual
grammar is derived from the thumbnails that *measurably* work on this channel and among its
competitors. Image generation runs on a user-supplied provider key (Gemini / OpenAI / fal),
selected and switchable on the Integrations page. Overlay text is composited by us, not by the
image model, so it stays sharp and editable.

## Problem Statement

The platform already tells the user *what* to make (Signals → idea → title, backed by the
statistically honest Winning Formula) but stops at the packaging step that decides whether the
video gets clicked. Today the user leaves the app, describes their channel to a generic image
tool from memory, and gets thumbnails that look like nothing they have ever shipped. Every
signal the app has already collected — OCR'd thumbnail text, per-video view multipliers,
competitor thumbnails with view counts, packaging word statistics — is exactly the evidence a
thumbnail generator needs, and it is sitting unused.

## Success Criteria

1. From an idea card, a user reaches four candidate thumbnails in one click and under two
   minutes, without leaving the app.
2. Every generated thumbnail can be traced to named source videos with their view multipliers —
   shown in the UI, not just logged.
3. No thumbnail set is generated from a single viral outlier: the style profile requires
   `n ≥ 5` mature winners or is explicitly labelled low-confidence.
4. Cost is visible before the click and recorded after it, from the provider's own usage
   numbers — not from an estimate we made up.
5. Works on a channel in any language and niche with no code change.

## Users

One persona: the channel owner (Eric), running the app locally, non-engineer, holds his own API
keys. He judges the feature by whether the pictures look like his channel — not by architecture.
Secondary consumer: the AI chat, which must be able to *see* the style profile and run history
(read-only) so "chat sees everything the user sees" stays true.

## Decisions Made During Discovery

| Decision | Choice | Rationale |
|---|---|---|
| Input to generation | Wave 1: title from Board idea / Signals / manual field. Wave 2: zero-input batch, remix of an existing video | Core engine is shared; wave-2 entry points become thin wrappers |
| Providers | All three selectable: Gemini, OpenAI, fal — one active at a time, key per entry | Eric's existing keys are unknown; give him a choice rather than guess |
| Overlay text | Hybrid — model paints the background, we composite the text | Sharp, re-editable, free to re-word; model text costs a new paid generation per typo |
| Competitor thumbnails | Passed to the model as **image** references, same as own | Explicit product-owner decision; see Risks for the mitigation |
| Style analysis | Claude vision over top-N mature winners → structured JSON profile, cached 7 days | Mirrors `packaging.ts` formula cache; generation then reads cache, pays nothing |
| Brand assets | User can upload character / logo / frame / font per channel | Faceless channels are recognised by a recurring element, not just a palette |
| Text renderer | `@napi-rs/canvas` + bundled font | Prebuilt binaries, `registerFromPath` — no dependence on the client machine's fonts |
| Font coverage | Latin + Cyrillic + Greek bundled; other scripts fall back to model-rendered text with an honest notice | CJK fonts add 20–40 MB to every install |
| Storage | PNG files under `data/thumbnails/`, paths + metadata in SQLite | Keeps `app.db` small; respects `DATA_DIR` |
| Style analysis trigger | Explicit button first time; auto-refresh only when profile is >7 days old **and** new mature videos exist | "Paid calls only on an explicit action" is an existing platform rule |
| Prompt visibility | Shown and editable before a re-run | Satisfies the transparency criterion and gives a cheap correction loop |
| Output | 1280×720, 16:9 only | Shorts support deferred until we know Eric ships Shorts |
| Chat access | Read-only tools; chat cannot spend money | Matches "Claude calls only on an explicit user action" |
| Cost guardrails | 4 variants default (slider 1–8), $ estimate on the button, spend counter in UI. No hard daily cap | Product-owner decision |

## User Journey (wave 1)

1. User is on **Ideation → Thumbnails**. Channel selector defaults to the active channel; a
   dropdown switches to any other owned channel.
2. First visit shows an empty state: *"Analyse what works on this channel"* with a button, an
   explanation of what will be read, and the Claude cost note. Nothing is charged until clicked.
3. The style job runs as a survivable server job with progress (`analysing 7/24 thumbnails`).
   The user may navigate away.
4. When it finishes, the tab shows the **style profile card**: the recurring visual grammar in
   plain sentences, each trait with `(n=…)`, traits below `n=5` marked *worth testing*, plus the
   thumbnail strip of the exact source videos with their multipliers and a link per video.
   Below it: *"Generation uses your channel's data and your competitors'. Add competitors on the
   Competitors tab."* with a live count of competitors currently feeding the profile.
5. The user picks a source for the title — a Board idea, a Signals title, or types one — sets the
   variant count, and sees the button read `Generate 4 — ~$0.54` with the active provider and
   masked key beside it.
6. Generation runs as a survivable job with per-variant progress.
7. Results: four cards, each with the composited final and a `Background only` toggle. Per card:
   edit overlay text, cycle text position among the profile's observed zones, re-render (free,
   no model call), download PNG, or **Pick** — which attaches it to the originating idea card.
8. A collapsed **Why this looks like this** block holds the exact prompt, the reference images
   sent, and the profile traits used. The prompt is editable; `Re-run with this prompt` spends a
   new generation.

## Functional Requirements

### P0 — Must have

**F1. Thumbnails tab.** New tab in `src/app/ideation/page.tsx` (`Image` icon from lucide),
component `src/components/ideation/thumbnails-tab.tsx`. Channel defaults to active, dropdown
lists the user's channels. All queries scoped by `channel_id`.

**F2. Winner selection (deterministic SQL, no LLM).**
- Own videos: `published_at` older than `MIN_AGE_DAYS` (14, reused from `packaging.ts`),
  `duration_seconds > 60` (excludes Shorts), ranked by `views / channel_median_views`.
  Take top 12; require `n ≥ 5` (`FORMULA_MIN_USES`) or mark the profile `lowConfidence`.
- Competitor videos: `competitor_videos` joined to the channel through `competitor_owners`,
  same maturity filter, ranked by `views / competitor_median_views`. Take top 12.
- The exact video ids used are persisted so the UI can show them.

**F3. Style profile job.** `POST /api/thumbnails/style` starts a job; `GET` returns
`{ profile, job }`. Job state in `settings` under `thumbnail.style.job`, 409 on duplicate
start, `STALE_JOB_MS = 2h`, progress written after every step — the exact shape used by
`src/app/api/videos/thumbnails-ocr/route.ts`.
Steps: download reference thumbnails (`maxresdefault` → `hqdefault` fallback) into
`data/thumbnails/_refs/<channel_id>/`; one Claude vision call (`claude-sonnet-4-6`, the model
`packaging.ts` already uses) with all images plus each image's multiplier; parse into:

```jsonc
{
  "composition":  { "summary": "...", "subjectPlacement": "...", "textZone": "top-left", "n": 9 },
  "palette":      { "dominant": ["#ff2d1f", "#0b0f1a"], "contrastStrategy": "...", "n": 9 },
  "subject":      { "facePresent": false, "recurringElement": "...", "scale": "...", "n": 7 },
  "textTreatment":{ "wordCountBand": "2-3", "case": "upper", "stroke": true,
                    "shadow": true, "weightClass": "extra-bold", "n": 11 },
  "mood":         { "summary": "...", "n": 9 },
  "avoid":        ["..."],
  "evidence":     { "composition": ["videoId", "..."] },
  "caveats":      ["face-in-frame seen in only 2 winners — worth testing, not a rule"]
}
```

Stored in `thumbnail_style_profiles` with sample sizes, source ids, model and `computed_at`.
Auto-recompute only when older than 7 days **and** at least one new mature winner exists.

**F4. Prompt construction.** A text-only Claude call turns `style profile + title + optional user
note + brand assets description` into (a) one image prompt and (b) 2–3 overlay text candidates
respecting the profile's observed word-count band. Language follows the channel's own titles —
no hardcoded language. The prompt explicitly instructs the model to **derive the visual grammar
from the references, not to reproduce any single reference's subject or layout**, and to leave
the profile's text zone visually calm.

**F5. Image provider abstraction.** `src/lib/image-provider.ts`, shaped after `ai-provider.ts`:

```ts
export type ImageProviderChoice = "gemini" | "openai" | "fal";

export interface GenerateImagesOpts {
  provider: ImageProviderChoice;
  apiKey: string;
  model: string;
  prompt: string;
  styleRefs: Buffer[];      // own + competitor winners
  characterRefs: Buffer[];  // brand assets
  count: number;
  aspectRatio: "16:9";
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  usage?: { outputTokens?: number; imageCount?: number };
}

export async function generateImages(o: GenerateImagesOpts): Promise<GeneratedImage[]>;
```

Verified provider facts (July 2026 — recheck before coding, these move):

| Provider | Default model | Reference-image limits | Output |
|---|---|---|---|
| Google | `gemini-3-pro-image` | up to **3 style refs** + 5 character + 6 object | 1K/2K/4K, aspect ratios incl. `16:9` |
| Google (cheap tier) | `gemini-3.1-flash-image` | up to 10 object + 4 character | 0.5K–4K |
| OpenAI | `gpt-image-2` | multiple input images via the edits endpoint, no documented cap; `input_fidelity` fixed high | any size, max edge 3840, multiples of 16 |
| fal | `seedream-4.5` / FLUX | model-dependent `image_urls` | model-dependent |

Because Gemini 3 Pro caps style references at three, the ranking decides what gets in: top own
winner, second own winner, top competitor winner — and the rest of the evidence reaches the model
as text. This is a provider limit, not a design preference; the UI states which references were
actually sent.

**F6. Generation job.** `POST /api/thumbnails/generate` (settings key `thumbnail.gen.job`, same
409/staleness/progress pattern). Per variant: call the provider, resize/crop to 1280×720, write
`…-base.png`, composite overlay, write `…-final.png`, insert a `thumbnail_variants` row, update
progress. A failed variant does not kill the run — it is recorded with its error and the others
continue.

**F7. Text compositing.** `src/lib/thumbnail-overlay.ts` using `@napi-rs/canvas`:
auto-fit font size to the text box, uppercase/stroke/shadow per profile, position from the
profile's text zone (override cycles through the other observed zones), bundled font registered
by path from `public/fonts/`. Re-render on text or position change is a pure local operation —
no model call, no cost. Before rendering, every glyph is checked against the font's coverage;
unsupported script → the run switches to model-rendered text and the UI says so plainly.

**F8. Provider configuration in Integrations.** New section with add / edit / delete / activate.
Multiple entries allowed, including several of the same provider with different keys. Exactly one
is active. Keys masked on read exactly like `src/app/api/integrations/route.ts` does
(`abcd••••••wxyz`) and never returned in full. The Thumbnails tab shows the active provider,
model and masked key.

**F9. Transparency panel.** Permanently visible on the tab (not behind a toggle): how many own
and competitor videos fed the profile, the multiplier threshold, the source thumbnails, the
competitor count with the *"add more on the Competitors tab"* prompt, and — collapsed — the exact
prompt plus the references actually sent.

**F10. Cost.** Estimate shown on the button from a per-provider table; measured cost written to
`thumbnail_runs.cost_cents` from provider usage after the run; a spend counter component in the
same style as `claude-usage` / `apify-usage`. Published rates as of 2026-07-24, to be verified
against the first real run before being shown as fact:
`gemini-3-pro-image` 1K/2K = 1120 output tokens ≈ $0.134/image; `gemini-3.1-flash-image` 1K
≈ $0.067/image; `gpt-image-2` image output $30 / 1M tokens (per-image varies with size and
quality); fal Seedream 4.5 ≈ $0.035/image.

**F11. Pick → Board.** Picking a variant stores it against the originating idea
(`ideas.thumbnail_variant_id`, idempotent migration) and the Board card renders it.

**F12. Chat visibility.** Two read-only tools added to `chat-tools.ts`:
`get_thumbnail_style_profile(channelId?)` and `list_thumbnail_runs(channelId?, limit?)`.
No generation tool — the chat must not spend the user's money.

### P1 — Should have (wave 2)

- **Zero-input batch**: take the top N Board ideas / hottest signals and generate for each.
- **Remix**: pick one of the channel's own published videos, generate alternatives for A/B.
- Side-by-side comparison of a generated thumbnail against the real one.

### P2 — Nice to have

- 9:16 Shorts output.
- Layer export (background PNG + text layer) for Photoshop/Canva finishing.
- Auto-refresh of the profile as a scheduled background job.

## Technical Architecture

### New files

```
src/lib/image-provider.ts            provider abstraction (gemini | openai | fal)
src/lib/image-provider-types.ts      constants/types importable by client components
src/lib/thumbnail-style.ts           winner selection + vision analysis + profile cache
src/lib/thumbnail-overlay.ts         @napi-rs/canvas compositing
src/lib/thumbnail-pricing.ts         per-provider cost table + measured-cost recording
src/app/api/thumbnails/style/route.ts        GET status/profile, POST start analysis job
src/app/api/thumbnails/generate/route.ts     GET job status, POST start generation job
src/app/api/thumbnails/runs/route.ts         history for the active channel
src/app/api/thumbnails/variants/[id]/route.ts  re-render overlay, pick, delete
src/app/api/thumbnails/file/[...path]/route.ts serve PNGs from data/ (path-traversal guarded)
src/app/api/image-providers/route.ts         list/create
src/app/api/image-providers/[id]/route.ts    update/delete/activate
src/app/api/brand-assets/route.ts            upload/list/delete
src/components/ideation/thumbnails-tab.tsx
src/components/image-provider-settings.tsx
src/components/thumbnail-usage.tsx
public/fonts/…                       bundled Latin+Cyrillic+Greek display font
```

### Modified files

`src/app/ideation/page.tsx` (tab), `src/app/integrations/page.tsx` (provider section),
`src/lib/db.ts` (tables + accessors + idempotent migrations), `src/lib/chat-tools.ts`
(two read tools), `src/components/ideation/board-tab.tsx` (show picked thumbnail),
`src/components/ideation/signals-tab.tsx` (Generate thumbnail on a generated title),
`package.json` (`@napi-rs/canvas`, `openai`).

### Data model

```sql
CREATE TABLE IF NOT EXISTS image_providers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT    NOT NULL,               -- 'gemini' | 'openai' | 'fal'
  label      TEXT    NOT NULL,
  api_key    TEXT    NOT NULL,
  model      TEXT,                           -- NULL = provider default
  is_active  INTEGER NOT NULL DEFAULT 0,     -- exactly one row = 1, enforced in the setter
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thumbnail_style_profiles (
  channel_id             TEXT PRIMARY KEY,
  profile_json           TEXT    NOT NULL,
  own_sample_size        INTEGER NOT NULL,
  competitor_sample_size INTEGER NOT NULL,
  own_video_ids          TEXT    NOT NULL,   -- JSON array
  competitor_video_ids   TEXT    NOT NULL,   -- JSON array
  low_confidence         INTEGER NOT NULL DEFAULT 0,
  model                  TEXT    NOT NULL,
  computed_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thumbnail_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT    NOT NULL,
  source_kind  TEXT    NOT NULL,             -- 'idea' | 'signal' | 'video_remix' | 'manual'
  source_id    TEXT,
  title        TEXT    NOT NULL,
  prompt       TEXT    NOT NULL,
  provider     TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  variants     INTEGER NOT NULL,
  cost_cents   INTEGER,                      -- measured after the run
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thumb_runs_channel ON thumbnail_runs(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS thumbnail_variants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES thumbnail_runs(id) ON DELETE CASCADE,
  base_path    TEXT    NOT NULL,
  final_path   TEXT,
  overlay_json TEXT,
  error        TEXT,
  picked       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_assets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  kind       TEXT NOT NULL,                  -- 'character' | 'logo' | 'frame' | 'font'
  label      TEXT,
  file_path  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Plus an idempotent `ALTER TABLE ideas ADD COLUMN thumbnail_variant_id INTEGER` following the
migration style already used in `db.ts`.

### Files on disk

```
data/thumbnails/_refs/<channel_id>/<video_id>.jpg      cached reference thumbnails
data/thumbnails/<channel_id>/<run_id>/<i>-base.png     model output, 1280×720, no text
data/thumbnails/<channel_id>/<run_id>/<i>-final.png    with overlay
data/brand-assets/<channel_id>/<id>-<name>             uploaded assets
```

All resolved through the same `DATA_DIR` helper `db.ts` uses, including its `process.cwd()`
fallback (commit `e078c3f` — Turbopack gives modules a virtual `__dirname`; a fresh clone
crashed on directory creation without it).

### Security

Local single-user app, no auth model change. Provider keys live in SQLite like every other key,
are masked on read, never logged, never echoed into prompts or error messages. The file-serving
route resolves and verifies the path is inside `DATA_DIR` before reading. Uploaded brand assets
are type- and size-checked (png/jpg/webp/ttf/otf, ≤10 MB).

## Non-Functional Requirements

- **Survivability**: both jobs run to completion server-side; navigation and reload do not kill
  them; a poll after reload shows accurate progress.
- **Per-channel**: no query without a `channel_id` scope; switching channels switches profile,
  history and brand assets.
- **Universality**: no hardcoded niche, language, palette or copy. Everything derives from the
  channel's own data.
- **Statistical honesty**: no trait becomes a rule below `n = 5`; every claim carries `(n=…)`;
  low-confidence profiles say so before the user spends money.
- **Latency**: style analysis ≤ 90 s for 24 references; a 4-variant generation ≤ 120 s on Gemini.
  Both measured, not assumed.
- **Install**: `npm install && npm run dev` still works on a clean Windows and macOS machine —
  `@napi-rs/canvas` ships prebuilt binaries; this must be verified on both before handoff.

## Out of Scope

Video generation; publishing to YouTube; A/B testing against live CTR (the app has no Studio CTR
write access); a full image editor; Shorts format; scheduled auto-generation; sharing thumbnails
between channels.

## Risks

| Risk | Mitigation |
|---|---|
| Competitor thumbnails as direct image references can produce a recognisable copy of a specific competitor video (product-owner decision, taken knowingly) | Prompt instructs derive-don't-reproduce; competitors never occupy more than one of Gemini's three style slots; the UI names every reference sent so the user can see what it was built from |
| `@napi-rs/canvas` is a native dependency on client machines | Verify a clean install on Windows and macOS before handoff; on load failure the tab degrades to model-rendered text instead of erroring |
| Provider model ids and prices move fast | All ids and prices in one table (`thumbnail-pricing.ts`, `image-provider-types.ts`); measured cost from provider usage overrides the estimate |
| No access to Eric's data yet — generation quality is unverifiable | Blocking for sign-off, not for building. See Open Questions |
| Bundled font does not cover the channel's script | Glyph coverage check before render, honest notice, automatic fallback to model-rendered text |

## Open Questions (for Eric / Vlad)

1. **Which keys does he already have?** `data/` is gitignored, so the repo shows nothing. Need
   his `app.db` or a screenshot of `/integrations` — it decides whether Gemini is zero-friction
   (key already present) or he needs a new one. Blocking for the quality check, not for the build.
2. **Does the channel have a recurring character / logo / frame?** Decides how much the brand
   assets slot matters in wave 1.
3. **Does he publish Shorts?** Decides whether 9:16 stays P2.

## Acceptance Criteria

Mapped to the brief's readiness checklist, each with how it gets verified:

| # | Criterion | Verification |
|---|---|---|
| 1 | Thumbnails tab in Ideation; defaults to the active channel, another can be chosen | Manual: switch channel, confirm profile/history/assets all change |
| 2 | Generation reflects several top videos, does not clone one viral hit | Profile row shows `own_sample_size ≥ 5`; the four variants are visibly distinct; recompute by hand from the DB and compare with the shown sample |
| 3 | Generation reflects competitor winners from the Competitors tab | Reference list in the panel names competitor videos; removing all competitors changes the profile and the UI says so |
| 4 | User sees what the result is based on, and the hint about adding competitors | Panel visible without expanding anything; prompt and references available on expand |
| 5 | Provider(s) and keys in Integrations; several allowed, switchable; active one visible on the tab | Add two entries, switch, confirm the tab header and the next run both follow the active one |
| 6 | Long generation is a survivable job with progress | Start, navigate away, reload — progress continues and completes |
| 7 | Per-channel and universal — any niche, any language | Run against a second channel in a different language; no English-only strings in output, no hardcoded niche terms in the code path |
| 8 | Cost honesty | Estimate on the button vs. recorded actual for the same run, compared on the first real run |

## Implementation status (2026-07-24)

P0 is built. `npx tsc --noEmit` is clean and `npm run build` is green.

**Verified by running it:**

| Check | How | Result |
|---|---|---|
| Font covers the promised scripts | cmap parse + render | Latin, Cyrillic, Greek covered; CJK correctly reported as uncovered with the exact missing glyphs |
| Text compositing | rendered PNGs and looked at them | Wraps, auto-fits, strokes and shadows correctly at 1280×720 |
| Winner selection | seeded a channel with a known median | Median 20 000 → top video reported at 13×; 6 winners above 1×; a 45-second Short with 900 K views correctly excluded by the duration filter |
| Overlay re-render through the running app | `PATCH /api/thumbnails/variants/1` with Cyrillic text | 200, composited PNG written and served |
| Unsupported script is refused, not fudged | same endpoint with Japanese | 400 naming every missing glyph |
| Path traversal on the file route | encoded `../` and a disallowed root | 404 both times |
| Provider CRUD and masking | create + list | Key stored, returned as `AIza••••••abcd`, first entry auto-activated |
| Guard order | generate with no key / no title / no profile | Correct 400 each time, with the message that tells the user what to do |

**Not verified, and cannot be from here:** the three provider adapters
(Gemini Interactions, OpenAI images, fal) have never been exercised
against a live key, and neither has the Claude vision analysis. Their
request shapes follow published documentation as of 2026-07-24 — that is
not the same as working. The first real run with Eric's keys is what
turns them green, and the per-image cost estimates should be compared
against the recorded `cost_cents` on that same run.

The smoke-test database was deleted afterwards; `data/` is recreated
empty on the next `npm run dev`.

### Wave 2 (also built, same day)

- **Brand assets**, API and UI: upload a character, logo, frame or font
  per channel. Image assets are sent to the model as character
  references. Verified: upload, type validation (a `.json` in the font
  slot is refused), listing, delete.
- **Custom font.** An uploaded `.ttf`/`.otf` replaces the bundled one for
  that channel — both for rendering and for the glyph-coverage check, so
  uploading a font that covers your script is the way to keep compositing
  text instead of handing it to the image model. Verified end to end by
  uploading a font and re-rendering a Cyrillic headline through the
  running app.
- **Remix**: pick one of your own published videos and generate
  alternative covers for the same title, so the generator can be judged
  against the cover that actually shipped.
- **Zero-input batch** (`POST /api/thumbnails/batch`): the app picks the
  titles — the longest-waiting cards in the Board's Idea column, or the
  hottest Niche Watch hits. Capped at 5 titles × 4 variants, shares the
  single-generation job key so the two can never spend concurrently, and
  states the image count and cost estimate before the button.
- The generation pipeline was extracted to `lib/thumbnail-generate.ts`
  and the pre-checks to `lib/thumbnail-preflight.ts`, so single, remix
  and batch runs are the same code path rather than three that drift.

### Dry run — the whole pipeline, verified without keys

`THUMBNAILS_DRY_RUN=1` replaces every paid call with a local stand-in:
the style analysis returns a placeholder profile, the prompt builder a
deterministic prompt, the image provider a locally drawn cover stamped
DRY RUN. Everything else runs for real. It exists because the two halves
of this feature fail differently — the half that talks to Anthropic and
an image provider can only be proven with a live key, while the half
that is plumbing is most of the code and needs no key at all.

Run end to end this way on a seeded channel:

| Step | Result |
|---|---|
| Style analysis job | Completed, profile stored, `lowConfidence=false` at 6 winners, caveat says plainly that no thumbnails were looked at |
| Generate, 3 variants | Job reached 3/3, three distinct PNGs written, headline composited at the profile's zone, `cost_cents` correctly NULL |
| Batch from the Board | 2 titles × 2 variants → 2 runs, 4 images |
| Concurrency guard | Generate during a batch → 409 |
| Pick → Board | Idea card carries `thumbnail_path`; the other card stays null |
| Delete a run | Rows and all 6 PNGs gone, folder removed, unknown id → 404 |
| UI | Screenshotted: tab, dry-run banner, basis panel with per-trait `(n=…)`, brand assets, three generate modes, history with spend and per-run cost |

The dry-run banner is deliberate: an image stamped DRY RUN can be
cropped, so the tab says it too.

Also added in this pass: **run history** in the UI with recorded spend
(the API existed with nothing rendering it), **run deletion** including
the PNGs on disk, and an **image-generation section in INSTALL.md**
covering provider choice, published rates, and the fact that nothing
generates without a click.

**Still not built:** Shorts 9:16 and layer export (both P2, and Shorts
waits on knowing whether Eric ships any).

## Appendix: Research Findings (2026-07-24)

- Gemini image models: `gemini-3-pro-image`, `gemini-3.1-flash-image`,
  `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`. Up to 14 reference images total;
  Gemini 3 Pro splits them as 6 object + 5 character + **3 style**. Sizes 512px/1K/2K/4K,
  aspect ratios include `16:9`.
  <https://ai.google.dev/gemini-api/docs/image-generation>
- Gemini pricing: `gemini-3-pro-image` output $120/1M tokens — "1K/2K images consume 1120 tokens
  and are equivalent to $0.134 per image"; `gemini-3.1-flash-image` output $60/1M tokens, 1K
  ≈ $0.067/image. <https://ai.google.dev/gemini-api/docs/pricing>
- OpenAI image models: `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`.
  Generations + edits endpoints; `size` any resolution up to 3840px edge in multiples of 16;
  `quality` low/medium/high/auto; `n` for multiple images; `input_fidelity` is fixed at high for
  `gpt-image-2`. <https://developers.openai.com/api/docs/guides/image-generation>
- OpenAI pricing per 1M tokens — `gpt-image-2`: text input $5.00, image input $8.00, image
  output $30.00; `gpt-image-1-mini`: $2.00 / $2.50 / $8.00.
  <https://developers.openai.com/api/docs/pricing>
- fal.ai: Seedream 4.5 ≈ $0.035/image, Seedream V4 ≈ $0.03/image, FLUX.1 [schnell] $0.003/MP,
  FLUX.2 [pro] $0.03/MP; billing is prepaid credits, failed 5xx not billed. Queue/API parameter
  details were not confirmed from primary docs — must be read from fal's own docs before coding
  the adapter. <https://pricepertoken.com/image>
- Existing patterns reused: job shape from `src/app/api/videos/thumbnails-ocr/route.ts`;
  `MIN_AGE_DAYS = 14`, `FORMULA_MIN_USES = 5`, `ANALYZER_MODEL = "claude-sonnet-4-6"`, 7-day
  cache from `src/lib/packaging.ts`; provider abstraction shape from `src/lib/ai-provider.ts`;
  key masking from `src/app/api/integrations/route.ts`.
