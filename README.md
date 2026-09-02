# YouTube Channel AI VIP

A local AI-powered YouTube channel analytics platform with an **AI thumbnail generator**: YouTube Studio-style dashboard (views, watch time, subscribers, audience, traffic, revenue), retention curves, video hook analyzer, AI chat with Claude over all your imported data, automatic transcript extraction, comment & competitor analysis — and a Thumbnails tab that generates covers in the style that measurably works on your channel.

> **This project runs locally on your computer.** All data lives in `~/.youtube-channel-ai-vip/app.db` — in your home folder, deliberately *outside* this project folder so that updating the app can never delete it. API keys are entered once on the **Integrations** page and stored in that local SQLite database — nothing is uploaded anywhere.

## Thumbnail generator

The **Ideation → Thumbnails** tab turns a video title into finished 16:9 covers built from the thumbnails that actually beat your channel's median views, plus your competitors'. See it in action: [`docs/demo/`](./docs/demo/) (English how-it-works, and a Ukrainian dark-theme walkthrough).

- Reads your best-performing thumbnails and your competitors', works out the shared visual grammar (composition, colour, headline banner, recurring elements), and generates new covers that follow it.
- Headline text is composited locally so it stays sharp and re-editable for free; the image model only paints the background.
- Image generation runs on your own key. Choose **Gemini 3 Pro** for quality (~16¢/image) or **Flash** for about half that. OpenAI, fal and kie.ai are also supported.
- Every run shows the price before you click and records what it actually cost after.
- Works per-channel and in any language — nothing is hardcoded to a niche.

## Quick start

Full step-by-step setup for someone who has never worked with code is in **[INSTALL.md](./INSTALL.md)**. Short version:

1. Install Node.js 20+ from [nodejs.org](https://nodejs.org/)
2. Download this repo — either as a ZIP from the green **Code** button above, or `git clone https://github.com/YT-Wizards/YouTube-Channel-AI-VIP.git`
3. Run `install.bat` (Windows) or `install.command` (macOS) — installs dependencies
4. Run `start.bat` (Windows) or `start.command` (macOS) — opens the app in your browser at `http://localhost:3010`
5. Open **Integrations** and add your keys (minimum: Claude + Deepgram)

## What it does

A web dashboard (opens in your browser at `localhost:3010`) that connects to:

- **Claude (Anthropic)** — AI analysis and chat about your channel (required)
- **Deepgram** — local video transcription (≈$0.0043/min)
- **YouTube Data API** — video details, stats, captions
- **Google OAuth** — your own Analytics + monetization data
- **Apify** (optional) — fallback path for transcription + competitor scraping
- **Google Gemini** — second AI brain for chat, thumbnail style analysis, and image generation
- **Image providers** for the thumbnail generator — Gemini, OpenAI, fal, or kie.ai; several keys can be stored and switched, one active at a time

## Where your data lives

Everything is in `~/.youtube-channel-ai-vip/` — your home folder, **not** this project folder. On macOS that is `/Users/<you>/.youtube-channel-ai-vip`, on Windows `C:\Users\<you>\.youtube-channel-ai-vip`. A single `app.db` SQLite file plus generated thumbnails. To reset, delete that folder — it gets recreated on next launch.

It sits outside the project on purpose: updating the app means replacing the project folder, and your data must survive that. If you installed before August 2026 your data was in `data/` inside the project — the app moves it across automatically the first time you start this version, and leaves the old copy behind untouched.

Setting the `DATA_DIR` environment variable overrides the location entirely (that is how the Railway deployments point at a mounted volume).

API keys, OAuth tokens, chat history, transcripts, analytics cache — all there. Nothing ever leaves your machine.

## Tech stack

- Next.js 16 (App Router) + React 19
- TypeScript + Tailwind CSS v4
- SQLite (`better-sqlite3`) in WAL mode with `synchronous=FULL` — data survives hard shutdowns
- Anthropic SDK (Claude) + Google Generative AI (Gemini)
- yt-dlp (via `youtube-dl-exec`) → Deepgram for transcription

## How to stop the app

Just close the terminal window the server is running in. The database closes cleanly on shutdown — nothing is lost.

## How to update

When the developer ships fixes or new features, follow **[UPDATE.md](./UPDATE.md)** — full step-by-step instructions, written for someone with no coding background. Covers both ZIP-based and GitHub Desktop-based installs, and explains how to switch to GitHub Desktop if you want one-click updates in the future.
