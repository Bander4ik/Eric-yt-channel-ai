"""Assemble: burn English subtitles + lay narration onto the recording."""
import json, os, subprocess, glob

HERE = os.path.dirname(os.path.abspath(__file__))
scenes = {s["id"]: s for s in json.load(open(os.path.join(HERE, "scenes.json")))}
timing = json.load(open(os.path.join(HERE, "timing.json")))
marks = timing["marks"]
video = os.path.join(HERE, timing["video"])
order = [s["id"] for s in json.load(open(os.path.join(HERE, "scenes.json")))]

def ts(sec):
    h = int(sec // 3600); m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")

# --- SRT ---
def wrap(t, n=42):
    words, lines, cur = t.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > n:
            lines.append(cur); cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur: lines.append(cur)
    return "\n".join(lines[:2]) if len(lines) <= 2 else "\n".join([lines[0], " ".join(lines[1:])])

srt = []
for i, sid in enumerate(order, 1):
    start = marks[sid]
    end = start + scenes[sid]["dur"]
    srt.append(f"{i}\n{ts(start)} --> {ts(end)}\n{wrap(scenes[sid]['text'])}\n")
open(os.path.join(HERE, "subs.srt"), "w", encoding="utf-8").write("\n".join(srt))

# --- narration track: each clip delayed to its mark, mixed ---
inputs = []
for sid in order:
    inputs += ["-i", scenes[sid]["audio"]]
filt = []
for idx, sid in enumerate(order):
    ms = int(marks[sid] * 1000)
    filt.append(f"[{idx}:a]adelay={ms}|{ms}[a{idx}]")
mix = "".join(f"[a{i}]" for i in range(len(order)))
filt.append(f"{mix}amix=inputs={len(order)}:normalize=0[out]")
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", *inputs,
     "-filter_complex", ";".join(filt), "-map", "[out]",
     "-c:a", "aac", "-b:a", "192k", os.path.join(HERE, "voice.m4a")],
    check=True)

# --- mux: video + voice, burn subtitles ---
srt_path = "subs.srt"  # relative; run from HERE to dodge Windows path colons
style = ("FontName=Arial,Fontsize=17,PrimaryColour=&H00FFFFFF,"
         "OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,"
         "Alignment=2,MarginV=28")
out = os.path.join(HERE, "thumbnail-generator-demo.mp4")
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error",
     "-i", os.path.basename(video), "-i", "voice.m4a",
     "-vf", f"subtitles={srt_path}:force_style='{style}'",
     "-map", "0:v", "-map", "1:a", "-shortest",
     "-c:v", "libx264", "-preset", "medium", "-crf", "20",
     "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
     "thumbnail-generator-demo.mp4"],
    cwd=HERE, check=True)
dur = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
    "format=duration", "-of", "default=nk=1:nw=1", out]).decode().strip()
print("built:", out, "|", round(float(dur), 1), "s",
      "|", round(os.path.getsize(out)/1e6, 1), "MB")
