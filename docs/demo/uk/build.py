"""Assemble the UK dark demo: single-line burnt subtitles + narration."""
import json, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
order = [s["id"] for s in json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8"))]
scenes = {s["id"]: s for s in json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8"))}
timing = json.load(open(os.path.join(HERE, "timing.json")))
marks = timing["marks"]
video = timing["video"]

def ts(sec):
    h=int(sec//3600); m=int((sec%3600)//60); s=sec%60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")

# SRT — one line per cue, no wrapping
srt=[]
for i, sid in enumerate(order, 1):
    start=marks[sid]; end=start+scenes[sid]["dur"]
    srt.append(f"{i}\n{ts(start)} --> {ts(end)}\n{scenes[sid]['text']}\n")
open(os.path.join(HERE,"subs.srt"),"w",encoding="utf-8").write("\n".join(srt))

# narration track: each clip at its mark, mixed
inputs=[]; filt=[]
for idx, sid in enumerate(order):
    inputs += ["-i", scenes[sid]["audio"]]
    ms=int(marks[sid]*1000)
    filt.append(f"[{idx}:a]adelay={ms}|{ms}[a{idx}]")
filt.append("".join(f"[a{i}]" for i in range(len(order)))+f"amix=inputs={len(order)}:normalize=0[out]")
subprocess.run(["ffmpeg","-y","-loglevel","error",*inputs,
    "-filter_complex",";".join(filt),"-map","[out]",
    "-c:a","aac","-b:a","192k",os.path.join(HERE,"voice.m4a")],check=True)

# single line: small font, no wrap; MarginV lifts it off the very edge
style=("FontName=DejaVu Sans,Fontsize=14,PrimaryColour=&H00FFFFFF,"
       "OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,"
       "Alignment=2,MarginV=24,WrapStyle=2")
subprocess.run(["ffmpeg","-y","-loglevel","error",
    "-i",video,"-i","voice.m4a",
    "-vf",f"subtitles=subs.srt:force_style='{style}'",
    "-map","0:v","-map","1:a","-shortest",
    "-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
    "-c:a","aac","-b:a","192k","thumbnail-generator-demo-uk.mp4"],
    cwd=HERE,check=True)
out=os.path.join(HERE,"thumbnail-generator-demo-uk.mp4")
dur=subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration",
    "-of","default=nk=1:nw=1",out]).decode().strip()
print("built:",out,"|",round(float(dur),1),"s |",round(os.path.getsize(out)/1e6,1),"MB")
