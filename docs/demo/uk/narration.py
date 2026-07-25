"""Ukrainian narration per scene, edge-tts, one short line each."""
import asyncio, json, subprocess, os
import edge_tts

VOICE = "uk-UA-OstapNeural"
OUT = os.path.dirname(os.path.abspath(__file__))

SCENES = [
    ("s1",  "Генератор перевʼюшок. Проходимось по технічному завданню, тема темна."),
    ("s2",  "Пункт один: вкладка Thumbnails, активний канал і вибір інших."),
    ("s3",  "Пункт два: стиль береться з кількох топ-відео каналу, а не з одного."),
    ("s4",  "Пункт три: враховуються й перевʼюшки конкурентів."),
    ("s5",  "Пункт чотири: видно, на яких даних усе побудовано."),
    ("s6",  "Пункт пʼять: провайдери й ключі в Integrations, з перемиканням."),
    ("s7",  "Пункт шість: генерація — фоновий процес із прогресом."),
    ("s8",  "Пункт сім: працює для будь-якої ніші та мови."),
    ("s9",  "Ось готові обкладинки каналу: плашка, стрілка, заголовок."),
    ("s10", "Кожен запуск записує реальну вартість. Без нових витрат зараз."),
    ("s11", "Усі пункти технічного завдання виконано."),
]

async def synth(sid, text):
    path = os.path.join(OUT, f"{sid}.mp3")
    await edge_tts.Communicate(text, VOICE, rate="+3%").save(path)
    dur = float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nk=1:nw=1", path]).decode().strip())
    return {"id": sid, "text": text, "audio": path, "dur": dur}

async def main():
    scenes = []
    for sid, text in SCENES:
        s = await synth(sid, text)
        scenes.append(s)
        print(f"{sid}: {s['dur']:.2f}s  {len(text)} chars")
    json.dump(scenes, open(os.path.join(OUT, "scenes.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("total:", round(sum(s["dur"] for s in scenes), 1), "s")

asyncio.run(main())
