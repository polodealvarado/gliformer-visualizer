# GLiFormer visualizer

Treat this as a personal project. Use the repository owner's personal Git identity. Keep company names and private data out of commits.

Run `uv sync` and `uv run server.py`. Open port 8766. The GLiNER2 visualizer uses port 8765.

Preserve the pinned model and framework revisions. Update `uv.lock`, provenance, lessons and architecture documentation together when changing either revision.

Use actual model tensors for every displayed activation, attention weight and score. Never substitute fabricated results for failed inference.

Keep the normal framework inference and decoder paths. Hooks may observe outputs and request hidden states and eager attention.

Serialize capture through the inference lock. Clear retained tensors after preparing each response.

Read `docs/architecture.md` before changing head instrumentation or educational explanations.

Distinguish the checkpoint's text-plus-layout inputs from vision encoders available in other GLiFormer variants. This checkpoint has no pixel or audio encoder.

Preserve character offsets through document word splitting. Align each model word to its source box. Reject stale boxes after text changes.

Keep joint extraction in one entity/relation group. Separate duplicate entity groups expose padded upstream relation rows.

Treat classification outputs as independent sigmoid scores. Do not normalize them with softmax.

Keep sentence embedding inference prompt-free. Do not reuse prompted extraction states as sentence embeddings.

Keep uploaded documents in memory. Only an explicit trace download may persist their contents.

Run `uv run pytest`, Ruff, `uv run server.py --offline --check`, and the browser check after material model or UI changes.

Regenerate static traces with `uv run bake.py` after backend or example changes. Run static browser QA against a plain HTTP server.

Keep Three.js vendored and preserve its license. Refresh vendor files with `uv run python scripts/vendor.py`.
