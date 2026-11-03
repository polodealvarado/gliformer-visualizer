"""Check the beginner LSTM explanation, traversal schematic and actual tensor strips."""

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8767")
    args = parser.parse_args()
    out = Path(__file__).resolve().parents[1] / "artifacts/lstm"
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True,
                                    args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.url)
        page.wait_for_function("document.querySelector('#timing').textContent.includes('inference')", timeout=120000)
        page.click("#start")
        for task in ("entities", "document"):
            page.click(f"#tasks [data-task='{task}']")
            page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
            assert page.locator("#error").is_hidden(), page.locator("#error").inner_text()
            page.locator("#rail .item").filter(has=page.locator(".t", has_text="Bidirectional LSTM")).click()
            page.click("[data-tab='what']")
            assert page.locator(".rnn-example").is_visible()
            assert "reader with a notepad" in page.locator("#panel-content").inner_text()
            page.click("[data-rnn-replay]")
            page.wait_for_timeout(800)
            page.locator("#inspector").evaluate("e=>e.scrollTop=0")
            page.screenshot(path=str(out / f"{task}-what.png"))
            page.click("[data-tab='data']")
            count = page.locator("#word-select option").count()
            for word in (0, count // 2, count - 1):
                page.select_option("#word-select", str(word))
                assert page.locator(".rnn-context > div").count() == 2
                assert page.locator(".heat-strip").count() == 2
                assert page.locator(".heat-strip span[title]").count() == 64
            page.wait_for_timeout(1000)
            page.screenshot(path=str(out / f"{task}-data.png"))
            page.click("[data-tab='tech']")
            assert "512 hidden units per direction" in page.locator("#panel-content").inner_text()
            assert "backward half starts at dimension 512" in page.locator("#panel-content").inner_text()
            # A replay may be interrupted safely by a stage or view change.
            page.click("[data-tab='what']")
            page.click("[data-rnn-replay]")
            page.click("#next")
            page.click("[data-view='map']")
            page.click("[data-view='tower']")
            print(f"OK LSTM: {task} · {count} words · first/middle/last positions", flush=True)
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
        assert not errors, errors
        browser.close()
    print("OK: beginner copy, both reading routes, replay, real vector strips and mobile layout.")


if __name__ == "__main__":
    main()
