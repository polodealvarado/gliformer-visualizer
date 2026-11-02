"""Contracts that protect source offsets, layout alignment and honest probabilities."""

import base64
import io
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from documents import example_document, read_document  # noqa: E402
from server import EXAMPLES, validate  # noqa: E402


@pytest.mark.parametrize("body", [None, [], {"text": "hi"}, {"text": "hi", "entities": "person"},
    {"text": "hi", "entities": ["person"], "threshold": float("nan")},
    {"text": "hi", "relations": ["works_for"]},
    {"text": "hi", "classes": {"topic": ["one"]}},
    {"text": "hi", "entities": ["person"], "structures": []}])
def test_rejects_malformed_requests(body):
    with pytest.raises(ValueError):
        validate(body)


def test_long_embedding_comparison_is_a_sentence_not_a_label():
    text = "A researcher investigates how people learn and remember important information in a laboratory."
    assert validate({"text": "A scientist works.", "compare": [text]})["compare"] == [text]


def test_nested_company_schema_is_accepted_without_flattening():
    example = EXAMPLES["structure"][1]
    assert validate(example)["structures"] == example["structures"]


def test_document_preserves_exact_offsets_and_normalized_geometry():
    doc = example_document()
    assert "Alice Morgan" in doc["text"] and "$3,000.00" in doc["text"]
    for word in doc["words"]:
        assert doc["text"][word["start"]:word["end"]] == word["text"]
        x0, y0, x1, y1 = word["bbox"]
        assert 0 <= x0 < x1 <= 1000 and 0 <= y0 < y1 <= 1000
    validate({"text": doc["text"], "entities": ["person"], "document": doc})


def test_rejects_document_text_edit_without_realigning_boxes():
    doc = example_document()
    with pytest.raises(ValueError, match="must match"):
        validate({"text": "Edited text", "entities": ["person"], "document": doc})


def test_rejects_misaligned_document_word():
    doc = example_document()
    doc["words"][0]["start"] += 1
    with pytest.raises(ValueError, match="do not match"):
        validate({"text": doc["text"], "entities": ["person"], "document": doc})


def test_generated_image_is_a_real_readable_page():
    doc = example_document()
    data = base64.b64decode(doc["image"].split(",")[1])
    im = Image.open(io.BytesIO(data))
    assert im.size == (640, 760)


def test_invalid_document_data():
    with pytest.raises(ValueError):
        read_document({"name": "bad.pdf", "data": "this is not base64"})
