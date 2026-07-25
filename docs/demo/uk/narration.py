"""Ukrainian narration: how the generator works, step by step. One line each."""
import asyncio, json, subprocess, os
import edge_tts

VOICE = "uk-UA-OstapNeural"
OUT = os.path.dirname(os.path.abspath(__file__))

SCENES = [
    ("s1",  "Ось як працює генератор перевʼюшок для ютуб-каналу."),
    ("s2",  "Спочатку обираєш канал угорі. Активний стоїть за замовчуванням."),
    ("s3",  "Система бере твої найкращі перевʼюшки, що обігнали медіану каналу."),
    ("s4",  "І додає перевʼюшки твоїх конкурентів для порівняння."),
    ("s5",  "З них виводиться стиль: ракурс, кольори, стрілка, плашка."),
    ("s6",  "Тут видно, на яких саме відео все побудовано."),
    ("s7",  "Провайдер і модель обираються в Integrations, з перемиканням."),
    ("s8",  "Вводиш назву відео, і на кнопці одразу видно ціну."),
    ("s9",  "Натискаєш, і генерація йде у фоні зі збереженням прогресу."),
    ("s10", "Ось готова обкладинка у стилі каналу: стрілка, плашка, заголовок."),
    ("s11", "А тут історія запусків із реальною вартістю кожного."),
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
