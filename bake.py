"""Record every example from a running real-model server for static hosting."""

import argparse
import gzip
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8766")
    args = parser.parse_args()

    def api(path, body=None):
        request = Request(args.url + path, data=json.dumps(body).encode() if body else None,
                          headers={"Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=180) as response:
                return json.load(response)
        except HTTPError as exc:
            raise RuntimeError(f"{path}: {exc.read().decode()}") from exc

    out = HERE / "static"
    out.mkdir(exist_ok=True)
    info, examples, document = api("/api/info"), api("/api/examples"), api("/api/document/example")
    (out / "document.json.gz").write_bytes(gzip.compress(json.dumps(document).encode(), mtime=0))
    manifest = {"info": info, "examples": examples, "traces": []}
    for task, items in examples.items():
        for index, example in enumerate(items):
            body = dict(example)
            if task == "document":
                body.update(text=document["text"], document=document)
            result = api("/api/analyze", body)
            assert len(result["layers"]) == info["layers"] + 1
            assert result["provenance"]["revision"] == info["revision"]
            file = f"{task}-{index}.json.gz"
            data = gzip.compress(json.dumps(result, ensure_ascii=False).encode(), compresslevel=6, mtime=0)
            (out / file).write_bytes(data)
            manifest["traces"].append({"task": task, "index": index, "file": file})
            print(f"{task}/{example['name']}: {result['ms']} ms inference, {len(data) / 1024:.0f} KiB", flush=True)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Saved {len(manifest['traces'])} real model traces to {out}")


if __name__ == "__main__":
    main()
