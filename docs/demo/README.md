# Thumbnail generator — demos

Two recordings of the thumbnails feature on a real channel (Daily
Discoveries), each with burnt-in subtitles:

- **`thumbnail-generator-demo.mp4`** — English, light theme, "how it
  works" walkthrough. The result cover was generated **live** during the
  recording on Gemini 3.1 Flash — not a mock-up. Scripts in this folder.
- **`thumbnail-generator-demo-uk.mp4`** — Ukrainian, dark theme,
  single-line subtitles, a point-by-point pass over the team lead's spec
  showing each requirement is met. Triggers **no** generation, so it
  spends nothing; it shows covers already in history. Scripts in `uk/`.

## What it walks through

1. The Thumbnails tab and channel picker
2. The evidence panel: the channel's own winning thumbnails and its competitors'
3. The style profile the model derives (aerial shot, red arrow, red headline banner)
4. Choosing the image model — Gemini Pro for quality, Flash for ~half the cost
5. Generating from a title, with the price shown on the button
6. The generation running as a survivable background job
7. The finished cover, in the channel's style and language
8. Run history with the real recorded cost per run

## How it was made (reproducible)

Requires a running dev server on `localhost:3001`, plus `edge-tts`,
Playwright (Python) and `ffmpeg`.

```bash
python narration.py   # English voiceover per scene + durations -> scenes.json
python record.py      # Playwright screen capture, scene-timed, live generation -> *.webm + timing.json
python build.py       # burn subtitles, lay the narration on the marks -> thumbnail-generator-demo.mp4
```

`record.py` stamps the wall-clock start of each scene, and `build.py`
lays every narration clip and subtitle against those stamps, so waiting
for a live generation mid-recording never drifts the audio out of sync.
