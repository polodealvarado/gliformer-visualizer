"""Download the pinned Three.js runtime for local and static use."""
from pathlib import Path
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1] / "vendor"
root.mkdir(exist_ok=True)
files = {"three.module.js": "build/three.module.js", "OrbitControls.js": "examples/jsm/controls/OrbitControls.js",
         "RoundedBoxGeometry.js": "examples/jsm/geometries/RoundedBoxGeometry.js",
         "LICENSE": "LICENSE"}
for name, source in files.items():
    with urlopen(f"https://cdn.jsdelivr.net/npm/three@0.160.0/{source}", timeout=30) as response:
        (root / name).write_bytes(response.read())
    print(f"Downloaded {name}")
