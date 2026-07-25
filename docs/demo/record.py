"""
Record the thumbnail generator flow with Playwright, scene-timed to the
narration. A real generation is kicked off mid-record so the "result"
scene shows a genuinely fresh cover, not a replay.
"""
import json, os, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "http://localhost:3001"
scenes = {s["id"]: s for s in json.load(open(os.path.join(HERE, "scenes.json")))}

GEN_TITLE = "Scotland Rewilded a Dead Coastline - Then Everything Changed"

MARKS = {}   # scene id -> seconds from video start
T0 = [0.0]   # set once recording begins

def hold(page, sid):
    """Mark when this scene starts on the video timeline, then hold it
    for the length of its narration. The mark is what the audio and
    subtitles are laid against, so any waiting between scenes never
    drifts them apart."""
    MARKS[sid] = time.time() - T0[0]
    time.sleep(scenes[sid]["dur"])

def flash(page, selector):
    """Briefly ring an element so the viewer's eye lands on it."""
    try:
        page.eval_on_selector(selector, """el => {
            el.scrollIntoView({behavior:'smooth', block:'center'});
            const o = el.style.boxShadow;
            el.style.transition='box-shadow .3s';
            el.style.boxShadow='0 0 0 4px #e0322e';
            setTimeout(()=>{el.style.boxShadow=o;}, 2200);
        }""")
    except Exception:
        pass

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 720},
            record_video_dir=HERE,
            record_video_size={"width": 1280, "height": 720},
        )
        page = ctx.new_page()
        T0[0] = time.time()

        # Pre-roll: load and reach the tab before the voice starts.
        page.goto(f"{BASE}/ideation")
        page.wait_for_load_state("networkidle")
        for b in page.query_selector_all("button"):
            if (b.inner_text() or "").strip() == "Thumbnails":
                b.click(); break
        page.wait_for_timeout(2500)
        audio_offset = 3.0
        page.wait_for_timeout(int(audio_offset * 1000))

        # Fire the real generation now, so it is finished by the result
        # scene without a long wait sitting in the middle of the video.
        page.evaluate("""([title]) => fetch('/api/thumbnails/generate', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ title, variants:1, aspect:'16:9', sourceKind:'manual' })
        })""", [GEN_TITLE])

        # S1 — intro, channel visible at the top
        flash(page, "select")
        hold(page, "s1")

        # S2 — basis panel: own + competitor winners
        page.eval_on_selector("text=What this is based on",
                              "el=>el.scrollIntoView({block:'start'})")
        page.wait_for_timeout(400)
        hold(page, "s2")

        # S3 — style profile
        try:
            page.eval_on_selector("text=Composition",
                                  "el=>el.closest('div').scrollIntoView({block:'center'})")
        except Exception:
            pass
        page.wait_for_timeout(400)
        hold(page, "s3")

        # S4 — providers / model choice in the header banner
        flash(page, "text=Generating with")
        hold(page, "s4")

        # S5 — the generate card: title field + priced button
        try:
            page.eval_on_selector("text=Generate",
                                  "el=>el.scrollIntoView({block:'center'})")
        except Exception:
            pass
        page.wait_for_timeout(300)
        flash(page, "input")
        hold(page, "s5")

        # S6 — it is working (background job)
        hold(page, "s6")

        # S7 — reload the run and show the fresh result. It was started
        # back in S1, so it should be done by now; poll briefly just in
        # case, then reload.
        for _ in range(15):
            done = page.evaluate("""async () => {
                const r = await fetch('/api/thumbnails/generate');
                const j = await r.json();
                return j.job && !j.job.running && j.latestRun
                       && j.latestRun.variants.some(v=>v.final_path);
            }""")
            if done:
                break
            page.wait_for_timeout(1000)
        page.reload()
        page.wait_for_load_state("networkidle")
        for b in page.query_selector_all("button"):
            if (b.inner_text() or "").strip() == "Thumbnails":
                b.click(); break
        page.wait_for_timeout(1500)
        try:
            imgs = page.query_selector_all("img")
            for im in imgs:
                src = im.get_attribute("src") or ""
                if "/api/thumbnails/file/" in src:
                    im.scroll_into_view_if_needed(); break
        except Exception:
            pass
        page.wait_for_timeout(400)
        hold(page, "s7")

        # S8 — history with recorded cost
        try:
            page.eval_on_selector("text=History",
                                  "el=>el.scrollIntoView({block:'center'})")
            page.wait_for_timeout(300)
            page.click("text=History")
        except Exception:
            pass
        page.wait_for_timeout(500)
        hold(page, "s8")

        page.wait_for_timeout(600)
        video_path = page.video.path()
        ctx.close()
        browser.close()

    json.dump({"marks": MARKS, "video": os.path.basename(video_path)},
              open(os.path.join(HERE, "timing.json"), "w"), indent=1)
    print("video:", video_path)
    print("marks:", {k: round(v, 2) for k, v in MARKS.items()})

main()
