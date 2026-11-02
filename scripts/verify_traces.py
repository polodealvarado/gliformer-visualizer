"""Check numeric and source-alignment invariants in every recorded model run."""

import gzip
import json
import math
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "static"
manifest = json.loads((root / "manifest.json").read_text())
for item in manifest["traces"]:
    data = json.loads(gzip.decompress((root / item["file"]).read_bytes()))
    text, count = data["input"]["text"], len(data["tokens"])
    assert data["provenance"]["revision"] == manifest["info"]["revision"]
    assert len(data["layers"]) == 25
    for layer in data["layers"][1:]:
        assert len(layer["attention"]) == count
        for row in layer["attention"]:
            assert all(0 <= p <= 1 for p in row)
            assert abs(sum(row) - 1) < 0.02
        for query in range(len(data["queries"])):
            for word in range(len(data["words"])):
                average = sum(head[query][word] for head in layer["heads"]) / len(layer["heads"])
                assert abs(average - layer["query_attention"][query][word]) < 0.0002
    for word in data["words"]:
        assert text[word["start"]:word["end"]] == word["text"]
    for entity in data["result"].get("ner", [[]])[0]:
        assert text[entity["start"]:entity["end"]] == entity["text"]
    for group in data["stages"].get("classes", []):
        for logit, probability in zip(group["logits"], group["probs"]):
            assert abs(1 / (1 + math.exp(-logit)) - probability) < 0.0002
    for record in data["stages"].get("records", []):
        assert len(record["objectness"]) == len(record["memberships"]) == 100
        assert all(len(row) == len(record["spans"]) for row in record["memberships"])
    embeddings = data.get("embeddings")
    if embeddings:
        assert all(len(v) == 1024 for v in embeddings["vectors"])
        for i, a in enumerate(embeddings["vectors"]):
            for j, b in enumerate(embeddings["vectors"]):
                cos = sum(x * y for x, y in zip(a, b)) / math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
                assert abs(cos - embeddings["similarities"][i][j]) < 0.0001
print(f"OK: all {len(manifest['traces'])} real traces: attention, source offsets, sigmoid scores, slots and full-vector cosines.")
