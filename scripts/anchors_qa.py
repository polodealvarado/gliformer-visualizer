"""Check selected-question provenance across entity, class, field and relation routes."""

import argparse
import gzip
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8767")
    args = parser.parse_args()
    out = Path(__file__).resolve().parents[1] / "artifacts/anchors"
    out.mkdir(parents=True, exist_ok=True)
    errors, traces = [], []

    def capture(response):
        if "/api/analyze" in response.url and response.ok:
            traces.append(response.json())
        elif response.url.endswith(".json.gz") and "/static/document.json.gz" not in response.url:
            data = json.loads(gzip.decompress(response.body()))
            if "queries" in data:
                traces.append(data)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True,
                                    args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1512, "height": 1100})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("response", capture)
        page.goto(args.url)
        page.wait_for_function("document.querySelector('#timing').textContent.includes('inference')", timeout=120000)
        page.click("#start")
        recorded = page.locator("body").evaluate("e=>e.classList.contains('static')")
        for task, example in (("entities", 0), ("classification", 0), ("classification", 1),
                              ("relations", 0), ("structure", 0), ("structure", 1),
                              ("document", 0), ("all", 0)):
            page.click(f"#tasks [data-task='{task}']")
            page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
            if example:
                page.locator("#examples [data-example]").nth(example).click()
                page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
            assert page.locator("#error").is_hidden(), page.locator("#error").inner_text()
            assert page.locator("#examples [data-example]").first.is_enabled()
            if recorded:
                assert page.locator("#text").is_disabled() and page.locator("#run").is_disabled()
            data = traces[-1]
            page.locator("#rail .item").filter(has=page.locator(".t", has_text="Anchors & task questions")).click()
            page.click("[data-tab='what']")
            assert "question sheet" in page.locator("#panel-content").inner_text()
            page.click("[data-tab='data']")
            for question in data["stages"]["anchors"]["questions"]:
                index = question["query"]
                page.select_option("#query-select", str(index))
                assert page.locator(f".question-example[data-question='{index}']").count() == 1
                assert question["label"] in page.locator(".question-output b").inner_text()
                assert "<<CHILD>>" not in page.locator(".question-output b").inner_text()
                assert "<<END>>" not in page.locator(".question-output b").inner_text()
                strips = page.locator(".heat-strip")
                assert strips.count() == 3
                for row, key in enumerate(("anchor", "label_vector", "fused")):
                    values = strips.nth(row).locator("span").evaluate_all("cells=>cells.map(c=>Number(c.title.split(': ')[1]))")
                    assert values == question[key], (task, question["label"], key)
            # The location question from the reported screenshot must use its own row.
            if task == "entities":
                index = next(i for i, q in enumerate(data["queries"]) if q["name"] == "location")
                page.select_option("#query-select", str(index))
                page.evaluate("()=>new Promise(resolve=>{let n=0;function next(){if(++n===65)resolve();else requestAnimationFrame(next);}next();})")
                page.locator("#inspector").evaluate("e=>e.scrollTop=0")
                page.screenshot(path=str(out / "entities-data.png"))
                page.click("[data-tab='what']")
                page.screenshot(path=str(out / "entities-what.png"))
                # Chip and dropdown selection must stay in sync across tabs.
                page.locator("#follow [data-query]").first.click()
                assert page.locator(".question-output b").inner_text() != 'Which words match “location”?'
                page.click("[data-tab='data']")
            for index, query in enumerate(data["queries"]):
                if query["kind"] not in ("schema", "relation"):
                    continue
                page.select_option("#query-select", str(index))
                assert page.locator(".question-example").count() == 0
                assert page.locator(".heat-strip").count() == 1
                if query["kind"] == "relation":
                    assert "separate route" in page.locator("#panel-content").inner_text()
            page.click("[data-tab='tech']")
            assert "2048 → 1024" in page.locator("#panel-content").inner_text()
            print(f"OK anchors: {task}/{example} · {len(data['stages']['anchors']['questions'])} exact label rows", flush=True)
        page.click("[data-tab='what']")
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
        assert not errors, errors
        browser.close()
    print("OK: beginner explanation, three real vectors per question, separate routes and mobile layout.")


if __name__ == "__main__":
    main()
