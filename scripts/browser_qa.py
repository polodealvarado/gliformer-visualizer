"""Exercise the live UI, document input and static playback in Chromium."""

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8766")
    parser.add_argument("--static", action="store_true")
    args = parser.parse_args()
    screenshots = ROOT / "artifacts" / ("static" if args.static else "live")
    screenshots.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--enable-webgl", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1512, "height": 982}, device_scale_factor=1)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url)
        page.wait_for_function("document.querySelector('#timing').textContent.includes('inference')", timeout=120000)
        page.wait_for_timeout(1100)
        assert page.locator("#scene").bounding_box()["width"] > 100
        page.screenshot(path=str(screenshots / "landing.png"))
        page.click("#start")
        for task in ("entities", "classification", "relations", "structure", "embedding", "document", "all"):
            page.click(f"#tasks [data-task='{task}']")
            page.wait_for_function("document.querySelector('#busy').hidden && !document.querySelector('#run').disabled", timeout=120000) if not args.static else page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
            assert page.locator("#error").is_hidden(), page.locator("#error").inner_text()
            page.click("#rail [data-step='0']")
            for tab in ("what", "data", "tech"):
                page.click(f"#panel-tabs [data-tab='{tab}']")
                assert page.locator("#panel-content").inner_text().strip()
            # Last decoder stage and its actual output.
            page.locator("#rail [data-step]").last.click()
            page.click("#panel-tabs [data-tab='data']")
            page.wait_for_timeout(900)
            page.screenshot(path=str(screenshots / f"{task}.png"))
            if task == "entities":
                assert "Marie Curie" in page.locator("#panel-content").inner_text()
                page.click("#rail .layer-grid button:nth-child(12)")
                page.click("#panel-tabs [data-tab='data']")
                page.select_option("#query-select", label="entity · person")
                page.select_option("#head-select", "3")
                page.wait_for_timeout(900)
                page.screenshot(path=str(screenshots / "attention.png"))
                page.click("[data-view='map']")
                page.locator("#map-layer").fill("18")
                page.wait_for_timeout(900)
                page.screenshot(path=str(screenshots / "map.png"))
                page.click("[data-view='tower']")
            if task == "document":
                page.click("[data-view='document']")
                page.locator("#doc-boxes rect").nth(10).click(force=True)
                assert "Box" in page.locator("#panel-content").inner_text()
                page.screenshot(path=str(screenshots / "document-boxes.png"))
                page.click("#rail .layer-grid button:nth-child(12)")
                page.click("#panel-tabs [data-tab='data']")
                assert "attention over page" in page.locator("#scene-subtitle").inner_text()
                assert page.locator("#doc-boxes rect[style]").count() > 0
                page.screenshot(path=str(screenshots / "document-attention.png"))
                if not args.static:
                    page.uncheck("#use-layout")
                    page.click("#run")
                    page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
                    assert "disabled" in page.locator("#scene-subtitle").inner_text()
            print(f"OK UI: {task}", flush=True)
        if not args.static:
            page.click("#tasks [data-task='entities']")
            page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
            assert page.locator("#error").is_hidden(), page.locator("#error").inner_text()
            page.fill("#text", "Alan Turing worked in London.")
            page.fill("#entities", "person, city")
            page.click("#run")
            page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
            page.locator("#rail [data-step]").last.click()
            page.click("#panel-tabs [data-tab='data']")
            assert "Alan Turing" in page.locator("#panel-content").inner_text()
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
        assert page.locator("#inspector").bounding_box()["width"] > 300
        page.screenshot(path=str(screenshots / "mobile.png"), full_page=True)
        page.click("#about") if page.locator("#about").is_visible() else None
        assert not errors, errors
        browser.close()
    print("OK: browser interactions, live values, responsive layout and no JavaScript exceptions.")


if __name__ == "__main__":
    main()
