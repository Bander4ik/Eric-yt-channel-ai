"""
Dark-theme step-by-step walkthrough of how the generator works. Each
step highlights the element it talks about for the whole scene. No
generation is triggered, so the recording spends nothing.
"""
import json, os, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "http://localhost:3001"
scenes = {s["id"]: s for s in json.load(open(os.path.join(HERE, "scenes.json"), encoding="utf-8"))}
MARKS = {}
T0 = [0.0]

def highlight(page, selector, dur):
    """Ring an element and keep it ringed for the whole scene."""
    ms = int(dur * 1000)
    try:
        page.eval_on_selector(selector, """(el, ms) => {
            el.scrollIntoView({behavior:'smooth', block:'center'});
            const o = el.style.boxShadow, r = el.style.borderRadius;
            el.style.transition='box-shadow .25s';
            el.style.boxShadow='0 0 0 4px #e0322e, 0 0 22px 4px rgba(224,50,46,.5)';
            el.style.borderRadius='6px';
            setTimeout(()=>{el.style.boxShadow=o; el.style.borderRadius=r;}, ms);
        }""", ms)
    except Exception:
        pass

def scene(page, sid, selector=None):
    MARKS[sid] = time.time() - T0[0]
    d = scenes[sid]["dur"]
    if selector:
        highlight(page, selector, d + 0.3)
        page.wait_for_timeout(400)
    time.sleep(d)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 720},
            color_scheme="dark",
            record_video_dir=HERE,
            record_video_size={"width": 1280, "height": 720},
        )
        ctx.add_init_script("try{localStorage.setItem('yt-channel-ai.theme','dark')}catch(e){}")
        page = ctx.new_page()
        T0[0] = time.time()

        page.goto(f"{BASE}/ideation")
        page.wait_for_load_state("networkidle")
        for b in page.query_selector_all("button"):
            if (b.inner_text() or "").strip() == "Thumbnails":
                b.click(); break
        page.wait_for_timeout(2500)

        scene(page, "s1")                                     # intro
        scene(page, "s2", "select")                           # channel picker
        scene(page, "s3", "text=your winners")               # own winners
        scene(page, "s4", "text=competitor winners")         # competitor winners
        scene(page, "s5", "text=Composition")                # derived style profile
        scene(page, "s6", "text=What this is based on")      # basis panel
        scene(page, "s7", "text=Generating with")            # provider / model
        scene(page, "s8", "input")                            # title field + priced button
        scene(page, "s9", "text=Generate")                   # generate button (not clicked)
        # result — an existing cover from history, no new spend
        imgs = page.query_selector_all("img")
        target = None
        for im in imgs:
            if "/api/thumbnails/file/" in (im.get_attribute("src") or ""):
                target = im; break
        if target:
            target.scroll_into_view_if_needed()
            page.wait_for_timeout(300)
        MARKS["s10"] = time.time() - T0[0]
        if target:
            box = target.bounding_box()
            page.evaluate("""(sel)=>{const im=[...document.querySelectorAll('img')].find(i=>(i.getAttribute('src')||'').includes('/api/thumbnails/file/'));
                if(im){im.style.boxShadow='0 0 0 4px #e0322e, 0 0 24px 6px rgba(224,50,46,.5)';im.style.borderRadius='6px';}}""", None)
        time.sleep(scenes["s10"]["dur"])
        # history with cost
        try:
            page.eval_on_selector("text=History", "el=>el.scrollIntoView({block:'center'})")
            page.wait_for_timeout(300)
            page.click("text=History")
            page.wait_for_timeout(500)
        except Exception:
            pass
        scene(page, "s11", "text=History")

        page.wait_for_timeout(500)
        vid = page.video.path()
        ctx.close(); browser.close()

    json.dump({"marks": MARKS, "video": os.path.basename(vid)},
              open(os.path.join(HERE, "timing.json"), "w"), indent=1)
    print("marks:", {k: round(v, 2) for k, v in MARKS.items()})

main()
