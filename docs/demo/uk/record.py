"""
Dark-theme walkthrough of the thumbnail generator, one scene per ТЗ
point. No generation is triggered — it shows covers already in history,
so the recording spends nothing.
"""
import json, os, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "http://localhost:3001"
scenes = {s["id"]: s for s in json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8"))}
MARKS = {}
T0 = [0.0]

def hold(sid):
    MARKS[sid] = time.time() - T0[0]
    time.sleep(scenes[sid]["dur"])

def to(page, selector, block="center"):
    try:
        page.eval_on_selector(selector, f"el=>el.scrollIntoView({{block:'{block}'}})")
        page.wait_for_timeout(350)
    except Exception:
        pass

def flash(page, selector):
    try:
        page.eval_on_selector(selector, """el => {
            el.scrollIntoView({behavior:'smooth', block:'center'});
            const o = el.style.boxShadow;
            el.style.boxShadow='0 0 0 4px #e0322e';
            setTimeout(()=>{el.style.boxShadow=o;}, 2000);
        }""")
    except Exception:
        pass

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 720},
            color_scheme="dark",
            record_video_dir=HERE,
            record_video_size={"width": 1280, "height": 720},
        )
        # force the app's own dark theme before any script runs
        ctx.add_init_script("try{localStorage.setItem('yt-channel-ai.theme','dark')}catch(e){}")
        page = ctx.new_page()
        T0[0] = time.time()

        page.goto(f"{BASE}/ideation")
        page.wait_for_load_state("networkidle")
        for b in page.query_selector_all("button"):
            if (b.inner_text() or "").strip() == "Thumbnails":
                b.click(); break
        page.wait_for_timeout(2500)

        # S1 intro
        hold("s1")
        # S2 point 1 — tab + channel picker
        flash(page, "select"); hold("s2")
        # S3 point 2 — own winners
        to(page, "text=What this is based on", "start"); hold("s3")
        # S4 point 3 — competitor winners
        to(page, "text=competitor winners"); hold("s4")
        # S5 point 4 — basis explanation + competitors hint
        to(page, "text=your competitors"); hold("s5")
        # S6 point 5 — provider banner (Integrations, switchable)
        flash(page, "text=Generating with"); hold("s6")
        # S7 point 6 — generate card / background job (NOT triggered)
        to(page, "text=Generate"); flash(page, "input"); hold("s7")
        # S8 point 7 — universality: channel dropdown holds channels in other langs
        flash(page, "select"); hold("s8")
        # S9 result — existing generated covers (no new spend)
        imgs = page.query_selector_all("img")
        for im in imgs:
            if "/api/thumbnails/file/" in (im.get_attribute("src") or ""):
                im.scroll_into_view_if_needed(); break
        page.wait_for_timeout(300); hold("s9")
        # S10 cost — history with recorded cost
        try:
            to(page, "text=History"); page.click("text=History"); page.wait_for_timeout(500)
        except Exception:
            pass
        hold("s10")
        # S11 outro — back to the top of the basis panel
        to(page, "text=What this is based on", "start"); hold("s11")

        page.wait_for_timeout(500)
        vid = page.video.path()
        ctx.close(); browser.close()

    json.dump({"marks": MARKS, "video": os.path.basename(vid)},
              open(os.path.join(HERE, "timing.json"), "w"), indent=1)
    print("video:", vid)
    print("marks:", {k: round(v, 2) for k, v in MARKS.items()})

main()
