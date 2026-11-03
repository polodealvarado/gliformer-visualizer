"""Follow a real question from anchor fusion to word scores and decoded entities."""

import argparse
import gzip
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8767")
    args = parser.parse_args()
    out = Path(__file__).resolve().parents[1] / "artifacts/scorer"
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

        def stage(title):
            page.locator("#rail .item").filter(has=page.locator(".t", has_text=title)).click()

        def check_pair(data, question, word):
            page.select_option("#query-select", str(question["query"]))
            page.select_option("#word-select", str(word))
            group, _, label = question["indices"]
            values = (data["stages"]["bio"][group]["probs"] if question["task"] == "ner"
                      else data["stages"]["records"][group]["field_bio"])
            actual = page.locator("[data-score]").all_inner_texts()
            assert actual == [f"{x:.3f}" for x in values[word][label]]
            strips = page.locator(".heat-strip")
            for row, expected in enumerate((question["fused"], data["word_vectors"][word])):
                result = strips.nth(row).locator("span").evaluate_all("cells=>cells.map(c=>Number(c.title.split(': ')[1]))")
                assert result == expected
            assert page.locator("#follow .on").get_attribute("data-query") == str(question["query"])

        data = traces[-1]
        stage("Anchors & task questions")
        page.select_option("#query-select", label="entity · person")
        page.click("[data-jump='scorer']")
        assert page.locator("#stage-title").inner_text() == "Question → word scores"
        page.click("[data-tab='data']")
        for question in data["stages"]["anchors"]["questions"]:
            for word in (0, 1, 2, len(data["words"]) - 1):
                check_pair(data, question, word)
        person = next(q for q in data["stages"]["anchors"]["questions"] if q["label"] == "person")
        check_pair(data, person, 1)
        page.click("[data-tab='what']")
        page.evaluate("()=>new Promise(resolve=>{let n=0;function next(){if(++n===65)resolve();else requestAnimationFrame(next);}next();})")
        page.locator("#inspector").evaluate("e=>e.scrollTop=0")
        page.screenshot(path=str(out / "word-comparison.png"))
        page.click("[data-jump='bio']")
        page.click("[data-tab='data']")
        assert page.locator("#bio-select").input_value() == "0"
        page.select_option("#bio-select", label="organization")
        assert page.locator("#follow .on").inner_text() == "organization"
        page.click("[data-tab='what']")
        page.click("[data-jump='scorer']")
        assert page.locator("#query-select option:checked").inner_text() == "entity · organization"
        page.select_option("#query-select", label="entity · person")
        stage("Entity decision")
        assert page.locator(".span-evidence h3").inner_text() == "Marie Curie"
        assert page.locator(".span-evidence tbody tr").count() == 2
        page.locator("#inspector").evaluate("e=>e.scrollTop=0")
        page.screenshot(path=str(out / "span-evidence.png"))
        print("OK: person → Marie / Curie / worked → all-word scores → Marie Curie", flush=True)

        for task, example in (("document", 0), ("structure", 1), ("all", 0)):
            page.click(f"#tasks [data-task='{task}']")
            page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
            if example:
                page.locator("#examples [data-example]").nth(example).click()
                page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
            assert page.locator("#error").is_hidden(), page.locator("#error").inner_text()
            data = traces[-1]
            stage("Question → word scores")
            page.click("[data-tab='data']")
            questions = [a for a in data["stages"]["anchors"]["questions"] if a["task"] in ("ner", "structuring")]
            for question in questions:
                check_pair(data, question, len(data["words"]) - 1)
            page.click("[data-tab='tech']")
            assert "3072 → 4096" in page.locator("#panel-content").inner_text()
            page.click("[data-tab='what']")
            destination = "fields" if questions[-1]["task"] == "structuring" else "bio"
            page.click(f"[data-jump='{destination}']")
            assert page.locator("#follow .on").get_attribute("data-query") == str(questions[-1]["query"])
            if task == "all":
                stage("Question → word scores")
                page.click("[data-view='map']")
                page.click("[data-tab='data']")
                index = next(i for i, q in enumerate(data["queries"]) if q["kind"] == "class")
                page.select_option("#query-select", str(index))
                page.click("[data-view='tower']")
                assert page.locator(".scorer-pair").get_attribute("data-question") == page.locator("#follow .on").get_attribute("data-query")
            print(f"OK: {task} · {len(questions)} exact word-scoring routes", flush=True)

        page.click("#tasks [data-task='classification']")
        page.wait_for_function("document.querySelector('#busy').hidden", timeout=120000)
        assert page.locator("#rail .t", has_text="Question → word scores").count() == 0
        stage("Anchors & task questions")
        page.click("[data-jump='classification']")
        assert page.locator("#stage-title").inner_text() == "Whole-text classification"
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth<=innerWidth+1")
        assert not errors, errors
        browser.close()
    print("OK: exact inputs/scores, label continuity, field reuse, separate classification route and browser errors.")


if __name__ == "__main__":
    main()
