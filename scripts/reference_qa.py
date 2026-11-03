"""Check the restored reference layout and every GLiFormer visual stage."""
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:8767")
args = parser.parse_args()
out = Path(__file__).resolve().parents[1] / "artifacts/reference"
out.mkdir(parents=True, exist_ok=True)
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1440, "height": 1050})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(args.url)
    page.wait_for_function("document.querySelector('#timing').textContent.includes('inference')", timeout=120000)
    page.wait_for_timeout(1500)
    page.screenshot(path=str(out / "landing.png"))
    page.click("#start")
    assert page.locator("#text").is_visible() and page.locator("#threshold").is_visible()
    assert "Playfair" in page.locator(".brand").evaluate("e=>getComputedStyle(e).fontFamily")
    assert page.locator("#analyze-form").bounding_box()["y"] < page.locator("main").bounding_box()["y"]
    for task in ("entities", "classification", "relations", "structure", "embedding", "document", "all"):
        page.click(f"#tasks [data-task='{task}']")
        page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
        assert page.locator("#error").is_hidden(), page.locator("#error").inner_text()
        stages = page.locator("#rail .item[data-step]").evaluate_all("els=>els.map(e=>({i:e.dataset.step,title:e.querySelector('.t').textContent}))")
        for stage in stages:
            page.click(f"#rail .item[data-step='{stage['i']}']")
            for tab in ("what", "data", "tech"):
                page.click(f"#panel-tabs [data-tab='{tab}']")
                assert page.locator("#panel-content").inner_text().strip(), stage
            if stage["title"] in ("Entity decision", "Start · end · inside", "Span-to-record membership", "Record slots", "Relation scores", "Sentence embeddings"):
                page.click("#panel-tabs [data-tab='what']")
                page.wait_for_timeout(1150)
                page.screenshot(path=str(out / f"{task}-{stage['i']}.png"))
        if task == "entities":
            page.locator("#rail .item[data-step]").last.click()
            page.click("#panel-tabs [data-tab='what']")
            page.wait_for_timeout(1300)
            page.screenshot(path=str(out / "entities.png"))
            page.locator("#follow [data-query]").nth(1).click()
            assert page.locator("#follow .on").count() == 1
            page.locator("#rail .layer-grid [data-step]").nth(11).click()
            page.click("#panel-tabs [data-tab='data']")
            page.select_option("#head-select", "3")
            page.wait_for_timeout(1100)
            page.screenshot(path=str(out / "attention.png"))
            page.click("[data-view='map']")
            page.locator("#map-layer").fill("18")
            page.wait_for_timeout(900)
            page.screenshot(path=str(out / "map.png"))
            page.click("[data-view='tower']")
        if task == "document":
            page.click("[data-view='document']")
            page.locator("#doc-boxes rect").nth(10).click(force=True)
            assert "Box" in page.locator("#panel-content").inner_text()
            page.screenshot(path=str(out / "document.png"))
        print("OK stages:", task, flush=True)
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
    page.screenshot(path=str(out / "mobile.png"), full_page=True)
    assert not errors, errors
    browser.close()
print("OK: reference typography/layout, every task's visual stages, query selection, attention, map and document.")
