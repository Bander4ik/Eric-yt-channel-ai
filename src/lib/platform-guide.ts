import "server-only";

/**
 * Platform guide — the single source of truth on what every page,
 * button, and feature of "YouTube Channel AI VIP" does.
 *
 * Why this exists: the chat AI is expected to answer "how does X work",
 * "where do I find Y", "why is Z empty" questions about the app itself,
 * not just the user's channel data. The system prompt carries a short
 * structural overview; this file carries the DEEP version, exposed to
 * the model through the `get_platform_help` tool so it can pull the
 * exact section it needs without bloating every prompt.
 *
 * Keep this in sync when pages / features change. It is the closest
 * thing the project has to user-facing documentation.
 */

export type PlatformGuideTopic =
  | "overview"
  | "dashboard"
  | "videos"
  | "hook-lab"
  | "formula-analyzer"
  | "hooks-library"
  | "competitors"
  | "chat"
  | "integrations"
  | "settings"
  | "jobs"
  | "troubleshooting";

export const PLATFORM_GUIDE_TOPICS: PlatformGuideTopic[] = [
  "overview",
  "dashboard",
  "videos",
  "hook-lab",
  "formula-analyzer",
  "hooks-library",
  "competitors",
  "chat",
  "integrations",
  "settings",
  "jobs",
  "troubleshooting",
];

const SECTIONS: Record<PlatformGuideTopic, string> = {
  overview: `# YouTube Channel AI VIP — what this app is

A local desktop application for YouTube creators and their teams. It
runs on the user's own machine (Next.js server + a local SQLite
database file at \`~/.youtube-channel-ai-vip/app.db\`, kept in the
user's home folder so that updating the app cannot delete it). Nothing
is hosted in the cloud — every API key the user pastes stays on their
machine.

## What it's for
Pulling a YouTube channel's full catalogue into a local database and
then analysing it from every angle: title formulas, opening-hook
quality, audience sentiment in the comments, competitor activity,
Studio-grade analytics, and an AI chat that can read all of it.

## Multi-channel
The user can connect more than one YouTube channel. One channel is
"active" at a time — picked via the Channel Switcher in the top bar.
Every per-channel view (Dashboard, Videos, Hook Lab, Formula Analyzer,
Competitors, and the AI chat's local tools) shows data for the ACTIVE
channel only.

## The sidebar (left navigation), grouped
- **(top)** Dashboard, Videos, AI Chat
- **Title insights**: Hook Lab, Formula Analyzer, Hooks Library
- **Research**: Competitors, Alerts
- **Config**: Settings (API keys, channel binding, usage, appearance — one page), Logs (hidden unless enabled)`,

  dashboard: `# Dashboard (/)

The landing page. Channel-level overview for the active channel.

## What's on it
- **KPI strip** — Subscribers, Total views, Videos, Average views.
- **Multi-channel tab bar** — when >1 channel is connected, switch
  between "All channels" (a combined cross-account summary) and any
  single channel.
- **Studio Overview** — a snapshot of recent YouTube Analytics data
  (needs Google OAuth connected).
- **Today's Earnings / Multi-channel Earnings** — revenue widgets
  (need OAuth + Owner-tier access).
- **Tags Overview** — the channel's most-used video tags.
- **Top by views / Top by engagement / Bottom by views** — ranked
  video lists.
- **Editor billing card** — OPTIONAL, hidden by default. Tracks how
  much the user owes a video editor (uploads × per-video rate). Turn
  it on in Settings → Optional sections.
- **Refresh button** (top right) — busts the analytics cache and
  re-pulls dashboard aggregates.

## Common questions
- "Why are my numbers stale?" → hit Refresh, or run a channel Sync
  from the Videos page.
- "Where did the earnings widgets go?" → they need Google OAuth
  connected in Settings → Required to work → Google OAuth.`,

  videos: `# Videos (/videos)

The full list of every video synced into the local database for the
active channel.

## Key actions
- **Sync channel button** (top right) — pulls the latest uploads,
  re-fetches stats for existing videos, fetches transcripts for new
  videos, and kicks off a comment sync. THIS is how new uploads get
  into the app after the initial connection. Run it whenever the
  creator has published something new.
- **Search / sort / duration filters** — filter the list.
- **Transcribe-all banner** — bulk-transcribe videos via Deepgram.
- **Sync-all-comments banner** — bulk-pull comments via the YouTube
  Data API.
- **Per-video page** (\`/videos/[id]\`) — click any video to open
  transcripts, comments, hook analysis, AI comment analysis, and
  YouTube Analytics (retention, traffic) for that one video.

## Common questions
- "New videos aren't showing up." → click **Sync channel**. The app
  only auto-syncs once, when the channel is first connected.
- "How do I get a transcript?" → the per-video page has a Transcribe
  button, or use the bulk Transcribe-all banner.`,

  "hook-lab": `# Hook Lab (/hooks)

AI-graded analysis of the opening 30-60 seconds ("the hook") of every
video that has a transcript.

## What it produces, per video
- **Formula classification** — one of: direct_question, statistic,
  comment_reference, personal_story, mystery, character_place_date,
  provocation, other.
- **7 quality scores (1-10)** — open_loop, value_promise, conflict,
  specific_language, identification, pacing, benefit.
- **Strengths** and **improvement ideas**.

## How to use it
- **"Analyze N pending" button** — runs the AI analyser over every
  video that has a transcript but no hook scores yet. Runs as a
  background job with a progress banner; can be cancelled.
- **Model picker** (next to the button) — choose Claude or a Gemini
  variant for the analysis. "Auto" uses Claude if its key is set,
  otherwise Gemini.
- **Tabs** — Dashboard (winning formula, averages), Rankings (every
  video scored), Video Cards (detailed per-video breakdowns), Playbook
  (all the feedback consolidated into one set of rules).

## Playbook tab
Consolidates every per-video hook analysis on the channel into ONE
picture, so the user doesn't have to read a few hundred separate
suggestions. Generated on demand with one AI call ("Generate" /
"Regenerate" button); the result is stored per channel and re-shown
until regenerated. Needs at least 5 analysed hooks — below that it
refuses, because patterns found in 2-3 videos are coincidence.

It shows:
- **How the AI read this channel** — its one-line understanding of the
  channel's format and intent. Shown first on purpose: every rule below
  is built on this reading, so the user should check it.
- **Verdict** — the single most important thing to change about the
  channel's hooks.
- **Diagnosis strip** — weakest and strongest of the 7 score
  dimensions, plus the winning formula and how many times the channel
  average views it pulls.
- **What keeps going wrong / what already works** — recurring themes
  clustered out of the per-video strengths and improvements, each with
  how many hooks it affects.
- **Paste this into your script prompt** — the deliverable: a block of
  rules, in plain English, that the user copies into the prompt he
  writes scripts with. Every rule is grounded in this channel's own
  numbers, and rules that would fight the channel's format (e.g. an
  analyser telling a calm/sleep channel to raise urgency) are dropped
  or reframed rather than passed through.
- **Honesty caution** — if higher-scoring hooks have NOT actually
  pulled more views on this channel, the tab says so and labels the
  rules as hypotheses instead of proven wins.

## Requirements
- Each video needs a transcript first (Videos page → Transcribe).
- Needs a Claude or Gemini API key in Settings.

## Common questions
- "Analyze pending does nothing / fails." → usually the AI provider
  has no credit (Claude billing) or no key. The banner shows the exact
  error. Top up at console.anthropic.com or switch the model picker to
  Gemini.`,

  "formula-analyzer": `# Formula Analyzer (/formula-analyzer)

A pure-statistics view of the channel's title catalogue. No AI — just
SQL aggregation over the user's own videos.

## What's on it
- **Optimal title length** — videos bucketed by word count
  (≤8 / 9-12 / 13-16 / 17+ words), each bucket showing average views.
  The longest bar = the title length that has historically pulled the
  most views on this channel.
- **Title words ranked by aggregate views** — every word that appeared
  in ≥2 titles, with: Uses (how many times used), Avg views, Success
  rate (share of videos with that word that beat 1.5× the channel
  median — green = consistent winner).
- **Top 10 / Bottom 10** — the channel's best and worst videos by
  views.

## Common questions
- "What does ≤8 / 17+ words mean?" → word count buckets, see above.
- "Success rate?" → % of videos containing that word that ended up
  ≥1.5× the channel's median views.`,

  "hooks-library": `# Hooks Library (/hooks-library)

A manual bookmark list. NOT AI-generated — it's where the creator
saves comment quotes or hook phrases they want to reuse as opening
lines in future videos.

## Fields per entry
- The quote / hook text, the author, a score the user can set,
  a status (available / used), and the source video.

## How entries get here
- The user adds them manually, often from the comment views or AI
  comment analysis ("best hook candidates").

## Common questions
- "It's empty." → expected until the user saves something. It's a
  curation tool, not an auto-populated one.`,

  competitors: `# Competitors (/competitors)

Track rival channels and watch what's working in the niche.

## Tabs
- **Overview** — add competitors by @handle / URL / channel ID. Each
  competitor card shows subs, video count, last sync. "Sync All"
  refreshes every tracked competitor.
- **Gap Analysis** — keywords that appear in competitors' TOP videos
  but in NONE of the user's own titles, ranked by aggregate views.
  A shopping list of proven keywords the user is missing.
- **Alerts** — outlier videos: a tracked competitor's video that
  crossed ≥2× that competitor's own median views. The leading
  indicator that something is going viral in the niche.

## Backend
Competitor sync uses the YouTube Data API key first; Apify is a
fallback only if no YouTube key is configured.

## Common questions
- "Sync fails." → check the YouTube Data API key in Settings.
  Gap analysis and alerts still work on already-synced data.`,

  chat: `# AI Chat (/chat)

The conversational interface. Talks to the user's whole local database
plus live tools.

## Controls
- **Session list** (left) — multiple independent conversations.
- **Model picker** (header) — Claude or Gemini variants. Web search is
  available on Claude turns only.
- **"+" tool menu** — every tool group is ON by default; the menu just
  lets the user see / toggle them.
- **Attachment picker (paperclip)** — pin specific videos (and their
  comments) into a turn so the AI focuses on them.
- **Image attach** — drop in a screenshot for the AI to look at.

## What the AI can see
Everything: channel stats, videos, transcripts, comments, Hook Lab
scores, Formula Analyzer stats, competitor data, YouTube Analytics,
plus web search. If a tool needs a key the user hasn't set, the AI
will say which key to add in Settings.

## Common questions
- "The chat gives generic answers." → make sure an AI provider key is
  set; ask a specific question; the AI works best when you give it
  details about your goal.`,

  integrations: `# API keys & connections — now part of Settings (/settings)

The former standalone Integrations page was merged into Settings
(2026-07): one page, no separate "Integrations" entry in the sidebar.
Old /integrations links still work — they redirect straight to
/settings. Each key is a single compact row (name, connected status,
masked value, Set/Replace button); setup steps are collapsed behind a
"how to get a key" disclosure per row.

## Settings page sections, top to bottom
- **Required to work** — YouTube Data API key (required to sync a
  channel), an AI provider picker (choose Claude or Gemini — only the
  chosen one's key field shows), and Google OAuth (optional but
  recommended — unlocks Studio Analytics and revenue).
- **Channel** — bind/sync the YouTube channel, manage YouTube cookies.
- **Optional** (collapsed by default) — Deepgram (transcription
  engine — required if you want video transcripts at all), Apify
  (competitor-scrape fallback), image-generation providers for
  Thumbnails.
- **Usage** (collapsed by default) — Claude / Apify / Deepgram spend
  and usage widgets.
- **Appearance** (collapsed by default) — theme, optional UI sections.

## Common questions
- "Which keys do I actually need?" → YouTube Data API + one AI key
  (Claude or Gemini). Everything else is optional.
- "Web search needs a key?" → no, it's built into Claude now.
- "Where did the Integrations page go?" → merged into Settings.`,

  settings: `# Settings (/settings)

One page for everything: API keys & connections (see above), channel
binding, optional add-ons, usage, and appearance.

- **Theme** — light / dark.
- **Optional sections** — toggles for power-user surfaces hidden by
  default: the Editor billing card on the Dashboard, and the Logs
  entry in the sidebar. The /logs route always works by direct URL;
  the toggle only controls sidebar visibility.`,

  jobs: `# Background jobs

Several actions run as background batch jobs with progress banners:
- **Channel sync** — pulls videos + transcripts + comments.
- **Bulk transcribe** — Deepgram transcription across many videos.
- **Bulk comment sync** — YouTube comments across many videos.
- **Bulk hook analysis** — Hook Lab scoring across many videos.

Each shows a live progress banner on its page and can be cancelled.
Only one job of each type runs at a time. If the server is closed
mid-job, the next launch marks the stale job as failed (so a banner
never spins forever).

## Common questions
- "A banner is stuck at 0/0." → the job died with the server. Click
  Cancel on the banner to clear it, then start fresh.
- "Why can't I sync — it says a job is running?" → channel sync,
  transcribe, and comment-sync don't run concurrently on purpose
  (they write the same tables). Wait for the active one to finish.`,

  troubleshooting: `# Troubleshooting / FAQ

- **New uploads not appearing** → Videos page → Sync channel button.
  The app only auto-syncs once, at initial connection.
- **AI feature fails with a billing error** → the Claude account is
  out of credit. Top up at console.anthropic.com, or switch to Gemini
  where a model picker exists (Hook Lab, chat header).
- **"API key not configured"** → Settings → the named row → paste
  key → Save.
- **YouTube Analytics widgets empty** → needs Google OAuth (Settings
  → Required to work → Google OAuth). Revenue specifically needs
  Owner-tier access on the channel.
- **Hook Lab "pending" count looks wrong** → it counts videos that
  have a transcript but no hook scores, for the ACTIVE channel only.
- **Wrong channel's data showing** → check the Channel Switcher in
  the top bar; the whole app is scoped to the active channel.
- **A progress banner spins forever** → the job's server process
  died; hit Cancel to clear the stale row.`,
};

/**
 * Return the guide. With no topic, returns the overview plus the list
 * of available topics so the model knows what else it can drill into.
 * With a topic, returns that section verbatim.
 */
export function getPlatformGuide(topic?: PlatformGuideTopic | string): string {
  if (topic && topic in SECTIONS) {
    return SECTIONS[topic as PlatformGuideTopic];
  }
  // No (or unknown) topic — hand back the overview + a topic index.
  return [
    SECTIONS.overview,
    ``,
    `---`,
    `For a deeper section, call get_platform_help again with one of these topics:`,
    PLATFORM_GUIDE_TOPICS.filter((t) => t !== "overview")
      .map((t) => `- ${t}`)
      .join("\n"),
  ].join("\n");
}
