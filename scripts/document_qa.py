"""Verify PDF upload, page selection, scanned-image OCR and model layout input."""

import base64
import json
from urllib.request import Request, urlopen

import pymupdf

URL = "http://127.0.0.1:8766"


def api(path, body=None):
    request = Request(URL + path, data=json.dumps(body).encode() if body else None,
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=120) as response:
        return json.load(response)


example = api("/api/document/example")
image = example["image"].split(",")[1]
ocr = api("/api/document", {"name": "invoice.png", "data": image})
assert "NORTHSTAR" in ocr["text"] and "Alice" in ocr["text"], ocr["text"]
assert ocr["source"] == "Tesseract OCR"

with pymupdf.open() as pdf:
    for text in ("Alice Morgan works in London.", "Bob Smith works in Paris."):
        page = pdf.new_page()
        page.insert_text((60, 80), text, fontsize=16)
    data = base64.b64encode(pdf.tobytes()).decode()

page = api("/api/document", {"name": "two-pages.pdf", "data": data, "page": 1})
assert page["pages"] == 2 and page["page"] == 1 and "Bob Smith" in page["text"]
assert page["source"] == "Embedded PDF text"
for document in (ocr, page):
    out = api("/api/analyze", {"text": document["text"], "document": document,
                              "entities": ["person", "city"], "threshold": 0.5})
    assert out["provenance"]["layout_used"] and not out["provenance"]["pixels_consumed"]
    assert out["spatial"] and len(out["spatial"]["boxes"]) == len(out["tokens"])
    for w in out["words"]:
        assert out["input"]["text"][w["start"]:w["end"]] == w["text"] and w["bbox"]
print("OK: image OCR, PDF upload, second-page selection and actual model box alignment.")
