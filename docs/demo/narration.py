"""Generate English narration per scene with edge-tts, measure each clip."""
import asyncio, json, subprocess, os
import edge_tts

VOICE = "en-US-AndrewNeural"
OUT = os.path.dirname(os.path.abspath(__file__))

SCENES = [
    ("s1", "This is the thumbnail generator, running live on a real YouTube channel: Daily Discoveries, twenty thousand subscribers."),
    ("s2", "It starts from evidence. It reads the thumbnails that already beat this channel's median views. Twelve of its own top performers, and twelve from its tracked competitors."),
    ("s3", "From those, the model builds a style profile: an aerial landscape, a red arrow on the subject, and a bold white headline on a solid red banner. Every trait lists the videos that prove it."),
    ("s4", "Image generation runs on the channel owner's own Gemini key. You choose the model. Gemini 3 Pro for the best quality, or Flash for about half the cost."),
    ("s5", "To make a cover, you give it a video title and press one button. The price is shown on the button before a cent is spent."),
    ("s6", "Generation runs as a background job, so you can leave the page and it keeps working. Right now it is calling Gemini live, painting a background in the channel's own style."),
    ("s7", "And here is the result. An aerial dead valley, the red arrow, the headline on the red banner. It is in English, because the profile learned the channel's language, not the subject of the video."),
    ("s8", "Every run records what it actually cost. Sixteen cents on Pro, nine on Flash. Real covers, from real channel data, with the real spend written down."),
]

async def synth(sid, text):
    path = os.path.join(OUT, f"{sid}.mp3")
    await edge_tts.Communicate(text, VOICE, rate="+4%").save(path)
    dur = float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nk=1:nw=1", path
    ]).decode().strip())
    return {"id": sid, "text": text, "audio": path, "dur": dur}

async def main():
    scenes = []
    for sid, text in SCENES:
        s = await synth(sid, text)
        scenes.append(s)
        print(f"{sid}: {s['dur']:.2f}s  {text[:50]}...")
    with open(os.path.join(OUT, "scenes.json"), "w", encoding="utf-8") as f:
        json.dump(scenes, f, indent=1)
    print("total narration:", round(sum(s["dur"] for s in scenes), 1), "s")

asyncio.run(main())
