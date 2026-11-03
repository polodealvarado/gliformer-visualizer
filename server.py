"""Instrument GLiFormer Large v1 and serve its actual intermediate tensors.

Run: uv run server.py. Open http://localhost:8766.
"""

import argparse
import gzip
import importlib.metadata
import json
import math
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import torch
import torch.nn.functional as F
from gliformer import BaseGLiFormer, GLiFormer
from huggingface_hub import snapshot_download
from transformers import PreTrainedTokenizerFast

from documents import example_document, read_document

HERE = Path(__file__).resolve().parent
MODEL_ID = "knowledgator/gliformer-large-v1"
MODEL_REVISION = "d0a4e53d09cebe6bc963dd9be319d4279084bb2d"
SOURCE_REVISION = "73d1dad5ebf1f34a00339f023b1fd77a6d1f386a"
MAX_WORDS, MAX_LABELS, MAX_TOKENS = 120, 24, 320
LOCK = threading.Lock()
EXAMPLES = json.loads((HERE / "examples.json").read_text())
SOURCE = f"https://github.com/Knowledgator/GLiFormer/blob/{SOURCE_REVISION}/"


def rounded(value, digits=4):
    if isinstance(value, torch.Tensor):
        value = value.detach().float().cpu().tolist()
    if isinstance(value, dict):
        return {k: rounded(v, digits) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [rounded(v, digits) for v in value]
    if isinstance(value, float):
        return round(value, digits) if math.isfinite(value) else None
    return value


def pca3(x, previous=None):
    """Normalize and project, aligning each layer to its predecessor."""
    x = F.normalize(x.detach().float().cpu(), dim=-1)
    x = x - x.mean(0)
    _, _, v = torch.linalg.svd(x, full_matrices=False)
    y = x @ v[:3].T
    y = F.pad(y, (0, max(0, 3 - y.shape[1])))
    y /= y.square().sum(-1).mean().sqrt().clamp_min(1e-6)
    if previous is not None:
        u, _, vt = torch.linalg.svd(y.T @ previous)
        y = y @ (u @ vt)
    return y


def names(value):
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise ValueError("Labels must be an array of strings.")
    if any(not v.strip() or len(v) > 70 for v in value):
        raise ValueError("Use nonempty labels of at most 70 characters.")
    return list(dict.fromkeys(v.strip() for v in value))


def structure_size(value, depth=0):
    if depth > 12:
        raise ValueError("Use a schema with at most six nested object/list levels.")
    if isinstance(value, str):
        if not value or len(value) > 70:
            raise ValueError("Use field names and types of 1 to 70 characters.")
        return 1
    if isinstance(value, list):
        if not value or len(value) > 16:
            raise ValueError("Each structure needs 1 to 16 fields, or one nested object exemplar.")
        return sum(structure_size(v, depth + 1) for v in value)
    if isinstance(value, dict) and value:
        for key in value:
            if not isinstance(key, str) or not key.strip() or len(key) > 70:
                raise ValueError("Use nonempty structure names of at most 70 characters.")
        return sum(structure_size(v, depth + 1) for v in value.values())
    raise ValueError("A structure must contain field names or a nested object schema.")


def validate(body):
    if not isinstance(body, dict):
        raise ValueError("Send a JSON object.")
    text = body.get("text", "")
    if not isinstance(text, str) or not text.strip() or len(text) > 3000:
        raise ValueError("Write a nonempty text of at most 3,000 characters.")
    if len(text.split()) > MAX_WORDS:
        raise ValueError(f"Use at most {MAX_WORDS} words so each stage remains readable.")
    threshold = body.get("threshold", 0.5)
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0.01 <= threshold <= 0.99:
        raise ValueError("Use a threshold from 0.01 to 0.99.")
    entities, relations = names(body.get("entities", [])), names(body.get("relations", []))
    classes, structures = body.get("classes", {}), body.get("structures", {})
    if not isinstance(classes, dict) or not isinstance(structures, dict):
        raise ValueError("Classes and structures must be JSON objects.")
    if len(classes) > 3 or any(not isinstance(k, str) or not 1 <= len(k) <= 70 for k in classes):
        raise ValueError("Use at most three named classification groups.")
    classes = {k: names(v) for k, v in classes.items()}
    if any(not 2 <= len(v) <= 8 for v in classes.values()):
        raise ValueError("Each classification group needs 2 to 8 labels.")
    count = len(entities) + len(relations) + sum(map(len, classes.values()))
    if structures:
        count += structure_size(structures)
    if count > MAX_LABELS:
        raise ValueError(f"Use at most {MAX_LABELS} labels and fields in total.")
    compare = []
    # Comparison sentences are longer than labels, so validate them separately.
    if body.get("compare"):
        compare = body["compare"]
        if not isinstance(compare, list) or len(compare) > 5:
            raise ValueError("Compare at most five sentences.")
        if any(not isinstance(v, str) or not v.strip() or len(v) > 300 for v in compare):
            raise ValueError("Comparison sentences need 1 to 300 characters.")
    if not count and not compare:
        raise ValueError("Ask for entities, classes, relations, structures or embedding comparisons.")
    if relations and not entities:
        raise ValueError("Joint relations need entity types as well as relation labels.")
    document = body.get("document")
    if document is not None:
        if not isinstance(document, dict) or document.get("text") != text:
            raise ValueError("The document and its text must match. Reload the document after changing text.")
        words = document.get("words", [])
        if not isinstance(words, list) or not 1 <= len(words) <= 300:
            raise ValueError("Use a document page containing 1 to 300 words.")
        last_end = 0
        for word in words:
            if not isinstance(word, dict):
                raise ValueError("Each document word needs text, character offsets and a box.")
            start, end, box = word.get("start"), word.get("end"), word.get("bbox")
            if not isinstance(start, int) or not isinstance(end, int) or not last_end <= start < end <= len(text):
                raise ValueError("Document character offsets must be ordered and inside its text.")
            if text[start:end] != word.get("text"):
                raise ValueError("Document word offsets do not match the text.")
            if not isinstance(box, list) or len(box) != 4 or any(type(v) is not int or not 0 <= v <= 1000 for v in box):
                raise ValueError("Document boxes need four integer coordinates from 0 to 1000.")
            if box[0] > box[2] or box[1] > box[3]:
                raise ValueError("A document box must run from its top left to its bottom right.")
            last_end = end
    return {"text": text, "entities": entities, "classes": classes, "relations": relations,
            "structures": structures, "compare": compare, "threshold": threshold,
            "multi_label": body.get("multi_label") is True, "use_layout": body.get("use_layout", True) is True,
            "document": document}


class Trace:
    """Hooks observe the normal forward path; the inference lock protects each trace."""

    def __init__(self, model):
        self.data = {}
        self.active = False
        self.head_stack = []
        self.model = model
        self.encoder = model.model.token_rep_layer.bert_layer.model

        def encoder_before(module, args, kwargs):
            if self.active:
                kwargs.update(output_hidden_states=True, output_attentions=True)
                self.data["encoder_inputs"] = kwargs
            return args, kwargs

        def encoder_after(module, args, output):
            if self.active:
                self.data["encoder"] = output

        def model_after(module, args, kwargs, output):
            if self.active:
                self.data.update(batch=kwargs, output=output)

        self.encoder.register_forward_pre_hook(encoder_before, with_kwargs=True)
        self.encoder.register_forward_hook(encoder_after)
        model.model.register_forward_hook(model_after, with_kwargs=True)
        anchor_modules = set()
        for name, head in model.model.heads.items():
            def head_before(module, args, kwargs, key=name):
                if self.active:
                    self.head_stack.append(key)

            def head_after(module, args, kwargs, output, key=name):
                if self.active:
                    self.data.setdefault("heads", {}).setdefault(key, []).append(output)
                    self.head_stack.pop()
            head.register_forward_pre_hook(head_before, with_kwargs=True)
            head.register_forward_hook(head_after, with_kwargs=True)
            if hasattr(head, "anchor_modeling") and id(head.anchor_modeling) not in anchor_modules:
                anchor_modules.add(id(head.anchor_modeling))

                def anchor_after(module, args, kwargs, output, key=name):
                    if self.active:
                        task = "structuring" if "structuring" in self.head_stack else self.head_stack[-1]
                        self.data.setdefault("anchors", []).append({"head": key, "task": task,
                            "anchor": args[0], "child": args[1], "output": output})
                head.anchor_modeling.register_forward_hook(anchor_after, with_kwargs=True)
        if hasattr(model.model, "rnn"):
            def rnn_after(module, args, output):
                if self.active:
                    self.data["rnn"] = (args[0], output)
            model.model.rnn.register_forward_hook(rnn_after)

    def reset(self):
        self.data = {}
        self.head_stack = []
        self.active = True


def load_model(name, revision, offline=False):
    folder = Path(name) if Path(name).is_dir() else Path(snapshot_download(
        name, revision=revision, local_files_only=offline,
        allow_patterns=["gliner_config.json", "pytorch_model.bin", "model.safetensors", "tokenizer*.json"],
    ))
    # Read the saved Rust tokenizer directly. Transformers 5 otherwise rebuilds its
    # 128k-entry Unigram vocabulary, delaying startup without changing its tokens.
    class VisualizerModel(GLiFormer._get_gliformer_class(GLiFormer._coerce_config(
            BaseGLiFormer._load_config(folder / "gliner_config.json")))):
        @classmethod
        def _load_tokenizer(cls, config, model_dir, cache_dir=None, local_files_only=False):
            cfg = json.loads((Path(model_dir) / "tokenizer_config.json").read_text())
            allowed = {k: cfg[k] for k in ("bos_token", "eos_token", "unk_token", "sep_token", "pad_token",
                                          "cls_token", "mask_token", "padding_side", "truncation_side") if k in cfg}
            tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(Path(model_dir) / "tokenizer.json"), **allowed)
            tokenizer.model_max_length = 16384
            return cls._set_tokenizer_spec_tokens(tokenizer)

    model = VisualizerModel.from_pretrained(str(folder), model_dir=str(folder), load_tokenizer=True,
                                            local_files_only=True, _attn_implementation="eager").eval()
    return model, folder.name if not Path(name).is_dir() else None


def model_info(model, name, revision):
    config = model.model.token_rep_layer.bert_layer.model.config
    def count(module):
        return sum(p.numel() for p in module.parameters())
    return {"name": name, "revision": revision, "source_revision": SOURCE_REVISION,
            "layers": config.num_hidden_layers, "hidden": config.hidden_size,
            "heads": config.num_attention_heads, "vocab": config.vocab_size,
            "params": count(model), "encoder_params": count(model.model.token_rep_layer),
            "rnn_layers": model.config.num_rnn_layers, "device": str(model.device),
            "tasks": list(model.model.heads), "layout": True, "pixel_encoder": False,
            "spatial_embedding": config.layout_embedding_type,
            "relative_layout_attention": config.layout_relative_attention,
            "record_slots": model.model.heads["structuring"].record_anchor_layer.num_slots,
            "head_params": {n: count(h) for n, h in model.model.heads.items()},
            "versions": {n: importlib.metadata.version(n) for n in ("gliformer", "gliner", "torch", "transformers")},
            "sources": {"encoder": SOURCE + "gliformer/backbones/deberta_2d.py",
                        "rnn": SOURCE + "gliformer/model.py",
                        "ner": SOURCE + "gliformer/tasks/ner/model.py",
                        "classification": SOURCE + "gliformer/tasks/classification/model.py",
                        "relations": SOURCE + "gliformer/tasks/joint_relex/model.py",
                        "structure": SOURCE + "gliformer/tasks/structuring/model.py",
                        "decoder": SOURCE + "gliformer/tasks/span_decoder.py",
                        "embedding": SOURCE + "gliformer/gliformer.py"}}


def make_words(model, spec):
    parts, starts, ends = model.prepare_inputs([spec["text"]])
    if len(parts[0]) > 180:
        raise ValueError("Use fewer than 180 model word units for this walkthrough.")
    words = [{"text": w, "start": s, "end": e} for w, s, e in zip(parts[0], starts[0], ends[0])]
    document = spec["document"]
    if document:
        for w in words:
            boxes = [d["bbox"] for d in document["words"] if d["start"] < w["end"] and d["end"] > w["start"]]
            if not boxes:
                raise ValueError("Every model word must have an aligned document box.")
            w["bbox"] = [min(b[0] for b in boxes), min(b[1] for b in boxes),
                         max(b[2] for b in boxes), max(b[3] for b in boxes)]
    return words


def tokenize_trace(model, batch):
    tokenizer = model.data_processor.transformer_tokenizer
    ids = batch["input_ids"][0].tolist()
    wm = batch["words_mask"][0].tolist()
    pieces = tokenizer.convert_ids_to_tokens(ids)
    # IDs come from this checkpoint; marker roles remain tied to its saved config.
    types = {getattr(model.config, k): v for k, v in (
        ("class_token_index", "entity"), ("cat_token_index", "class"),
        ("rel_token_index", "relation"), ("child_token_index", "field"), ("parent_token_index", "schema"))}
    queries = []
    for i, tid in enumerate(ids):
        if tid in types and wm[i] == 0:
            end = i + 1
            while end < len(ids) and ids[end] not in types and ids[end] != tokenizer.sep_token_id and wm[end] == 0:
                end += 1
            label = tokenizer.decode(ids[i + 1:end]).strip() or "shared schema"
            parent = next((j for j in range(len(queries) - 1, -1, -1) if queries[j]["kind"] == "schema"), None)
            queries.append({"token": i, "name": label, "kind": types[tid],
                            "parent": parent if types[tid] != "schema" else None})
    # The canonical mapping excludes structural CHILD/END prompt syntax and
    # preserves requested names even when tokenizer normalization changes text.
    mapping = batch["classes_mapping"]
    names = {
        "entity": [name for group in mapping.extraction_mapping for item in group.items
                   for name in item.ner_class_to_id.class_to_id],
        "relation": [name for group in mapping.extraction_mapping for item in group.items
                     if item.rel_class_to_id is not None for name in item.rel_class_to_id.class_to_id],
        "class": [name for group in mapping.cat_mapping for item in group.cat_class_to_id
                  for name in item.class_to_id],
        "field": [name for group in mapping.structuring_mapping for item in group.items
                  for name in item.field_class_to_id.class_to_id],
    }
    for kind, labels in names.items():
        markers = [query for query in queries if query["kind"] == kind]
        if len(markers) != len(labels):
            raise ValueError(f"Prompt marker count does not match {kind} labels.")
        for query, label in zip(markers, labels):
            query["name"] = label
    qm = {q["token"]: i for i, q in enumerate(queries)}
    tokens = [{"piece": p, "id": tid, "kind": "text" if wm[i] > 0 else
               (types.get(tid, "special" if tid in tokenizer.all_special_ids else "prompt")),
               "word": wm[i] - 1 if wm[i] > 0 else None, "query": qm.get(i)}
              for i, (tid, p) in enumerate(zip(ids, pieces))]
    return tokens, queries


def encoder_trace(trace, tokens, queries, words):
    enc = trace.data["encoder"]
    positions = [q["token"] for q in queries]
    word_tokens = [next(i for i, t in enumerate(tokens) if t["word"] == w) for w in range(len(words))]
    previous, layers = None, []
    for index, hidden in enumerate(enc.hidden_states):
        h = hidden[0].detach().float().cpu()
        p = pca3(h, previous)
        previous = p
        similarity = F.cosine_similarity(h[positions, None], h[None, word_tokens], dim=-1) if positions else h.new_zeros((0, len(words)))
        layer = {"pos": rounded(p), "strip": rounded(h[:, :32], 3), "similarity": rounded(similarity),
                 "norms": rounded(h.norm(dim=-1), 2)}
        if index:
            attention = enc.attentions[index - 1][0].detach().float().cpu()
            mean = attention.mean(0)
            per_word = mean.new_zeros((len(positions), len(words)))
            for i, t in enumerate(tokens):
                if t["word"] is not None and positions:
                    per_word[:, t["word"]] += mean[positions, i]
            # Individual heads for query-to-word inspection; full token map is the mean.
            head_words = attention.new_zeros((attention.shape[0], len(positions), len(words)))
            for i, t in enumerate(tokens):
                if t["word"] is not None and positions:
                    head_words[:, :, t["word"]] += attention[:, positions, i]
            layer.update(attention=rounded(mean), query_attention=rounded(per_word), heads=rounded(head_words))
        layers.append(layer)
    return layers


def span_text(words, text, s, e):
    s, e = int(s), int(e)
    if not 0 <= s <= e < len(words):
        return {"text": "", "start": 0, "end": 0, "s": s, "e": e}
    start, end = words[s]["start"], words[e]["end"]
    return {"text": text[start:end], "start": start, "end": end, "s": s, "e": e}


def anchor_trace(trace, batch, queries):
    """Associate every real fusion row with its prompt marker, including reused NER calls."""
    mapping = batch["classes_mapping"]
    questions = []
    for capture in trace.data.get("anchors", []):
        task = capture["task"]
        if task == "ner":
            kind = "entity"
            groups = [item.ner_class_to_id for item in mapping.extraction_mapping[0].items]
        elif task == "classification":
            kind = "class"
            groups = mapping.cat_mapping[0].cat_class_to_id
        elif task == "structuring":
            kind = "field"
            groups = [item.field_class_to_id for item in mapping.structuring_mapping[0].items]
        else:
            raise ValueError(f"Unmapped anchor capture: {task}")
        markers = iter((index, query) for index, query in enumerate(queries) if query["kind"] == kind)
        value = capture["output"]
        for group, labels in enumerate(groups):
            for child, label in enumerate(labels.class_to_id):
                index, query = next(markers)
                if query["name"] != label:
                    raise ValueError("Captured anchor labels do not match prompt order.")
                questions.append({"query": index, "parent": query["parent"], "task": task,
                    "head": capture["head"], "group": labels.name or "entities", "label": label,
                    "shape": list(value.shape), "indices": [group, 0, child],
                    "anchor": rounded(capture["anchor"][group, 0, :32], 3),
                    "label_vector": rounded(capture["child"][group, child, :32], 3),
                    "fused": rounded(value[group, 0, child, :32], 3)})
    return {"questions": questions}


def extraction_trace(output, batch, spec, words):
    result = {"bio": [], "classes": [], "pairs": [], "records": []}
    mapping = batch["classes_mapping"]
    if output.ner_logits is not None:
        maps = [it.ner_class_to_id for it in mapping.extraction_mapping[0].items]
        for index, m in enumerate(maps):
            result["bio"].append({"group": m.name or "entities", "labels": list(m.class_to_id),
                                   "probs": rounded(output.ner_logits[index, :len(words), :len(m.class_to_id)].sigmoid())})
    if output.cat_logits is not None:
        for index, m in enumerate(mapping.cat_mapping[0].cat_class_to_id):
            logits = output.cat_logits[index, :len(m.class_to_id)]
            result["classes"].append({"group": m.name, "labels": list(m.class_to_id),
                                      "logits": rounded(logits), "probs": rounded(logits.sigmoid())})
    if output.joint_rel_logits is not None:
        maps = mapping.extraction_mapping[0].items
        for g, m in enumerate(maps):
            if m.rel_class_to_id is None:
                continue
            for p in range(output.joint_rel_idx.shape[1]):
                if output.joint_rel_mask is not None and not bool(output.joint_rel_mask[g, p]):
                    continue
                hi, ti = output.joint_rel_idx[g, p].tolist()
                hs, ts = output.joint_rel_entity_spans[g, hi], output.joint_rel_entity_spans[g, ti]
                h = span_text(words, spec["text"], *hs)
                t = span_text(words, spec["text"], *ts)
                for c, name in enumerate(m.rel_class_to_id.class_to_id):
                    result["pairs"].append({"head": h, "tail": t, "relation": name,
                                             "score": round(float(output.joint_rel_logits[g, p, c].sigmoid()), 5)})
        result["pairs"].sort(key=lambda p: -p["score"])
    if output.structuring_logits is not None:
        for g, m in enumerate(mapping.structuring_mapping[0].items):
            valid = output.structuring_span_mask[g].bool()
            spans = output.structuring_span_idx[g][valid]
            field_probs = output.structuring_field_logits[g][valid].sigmoid()
            memberships = output.structuring_logits[g, :, valid].sigmoid()
            obj = output.structuring_objectness_logits[g].sigmoid()
            active = output.structuring_anchor_mask[g].bool()
            relations = output.structuring_anchor_relation_scores
            order = sorted(torch.where(active)[0].tolist(), key=lambda i: -float(obj[i]))
            result["records"].append({"name": m.name, "fields": list(m.field_class_to_id.class_to_id),
                "spans": [span_text(words, spec["text"], *s) for s in spans],
                "field_bio": rounded(output.structuring_entity_logits[g, :len(words)].sigmoid()),
                "field_probs": rounded(field_probs), "objectness": rounded(obj),
                "memberships": rounded(memberships), "slot_order": order,
                "anchor_relations": rounded(relations[g]) if relations is not None else None})
    return result


def analyze(model, trace, spec):
    words = make_words(model, spec)
    trace.reset()
    started = time.perf_counter()
    base_collator = model.create_inference_collator(return_tokens=True)

    def collator(items):
        if spec["document"] and spec["use_layout"]:
            for item in items:
                item["bboxes"] = [w["bbox"] for w in words]
                item["word_page_ids"] = [0] * len(words)
        batch = base_collator(items)
        if batch["input_ids"].shape[1] > MAX_TOKENS:
            raise ValueError(f"Use a shorter sentence or schema (limit: {MAX_TOKENS} subword tokens).")
        return batch

    # A single joint group supplies both NER and relations. Duplicate entity
    # groups create padded relation rows in the upstream decoder.
    kwargs = {"classes": spec["classes"] or None, "structures": spec["structures"] or None,
              "threshold": spec["threshold"], "multi_label": spec["multi_label"],
              "inference_collator": collator, "return_anchor_diagnostics": bool(spec["structures"])}
    if spec["relations"]:
        kwargs["joint_relations"] = {"relations": {"entities": spec["entities"], "relations": spec["relations"]}}
    else:
        kwargs["entities"] = spec["entities"] or None
    try:
        with torch.inference_mode():
            if spec["entities"] or spec["classes"] or spec["structures"]:
                result = model.inference(spec["text"], **kwargs)
                inference_ms = round((time.perf_counter() - started) * 1000)
                batch, output = trace.data["batch"], trace.data["output"]
                tokens, queries = tokenize_trace(model, batch)
                layers = encoder_trace(trace, tokens, queries, words)
                stages = extraction_trace(output, batch, spec, words)
                stages["anchors"] = anchor_trace(trace, batch, queries)
                word_vectors = rounded(output.words_embedding[0, :len(words), :32], 3)
                rnn = trace.data.get("rnn")
                rnn_data = {"before": rounded(rnn[0][0, :len(words), :32], 3),
                            "after": rounded(rnn[1][0, :len(words), :32], 3)} if rnn else None
                layout_input = trace.data["encoder_inputs"]
                bbox = layout_input.get("bbox")
                spatial = trace.encoder.embeddings.spatial_embeddings(bbox) if bbox is not None else None
                spatial_data = {"boxes": bbox[0].tolist(), "strip": rounded(spatial[0, :, :32], 3)} if spatial is not None else None
            else:
                result, stages, word_vectors, rnn_data, spatial_data = {}, {}, [], None, None
                # embed_text has no prompt and no word RNN; capture its own encoder run.
                vectors = model.embed_text([spec["text"], *spec["compare"]], batch_size=6)
                inference_ms = round((time.perf_counter() - started) * 1000)
                tokenizer = model.data_processor.transformer_tokenizer
                encoded = tokenizer(spec["text"], return_offsets_mapping=True)
                tokens = []
                for tid, (s, e) in zip(encoded["input_ids"], encoded["offset_mapping"]):
                    wi = next((i for i, w in enumerate(words) if s < w["end"] and e > w["start"]), None)
                    tokens.append({"id": tid, "piece": tokenizer.convert_ids_to_tokens(tid), "word": wi,
                                   "query": None, "kind": "text" if wi is not None else "special"})
                queries = []
                # Strip batch padding; the first sentence is the one explored in 3D.
                n = len(tokens)
                enc = trace.data["encoder"]
                trace.data["encoder"] = type(enc)(last_hidden_state=enc.last_hidden_state[:, :n],
                    hidden_states=tuple(h[:, :n] for h in enc.hidden_states),
                    attentions=tuple(a[:, :, :n, :n] for a in enc.attentions))
                layers = encoder_trace(trace, tokens, queries, words)

            embeddings = None
            trace.active = False  # text embeddings are a separate, prompt-free encoding pass
            if spec["compare"]:
                if result:
                    vectors = model.embed_text([spec["text"], *spec["compare"]], batch_size=6)
                unit = F.normalize(vectors.float(), dim=-1)
                embeddings = {"texts": [spec["text"], *spec["compare"]], "vectors": rounded(vectors, 5),
                              "similarities": rounded(unit @ unit.T, 5), "dimensions": vectors.shape[-1]}
    finally:
        trace.active = False
    cleaned = {k: v for k, v in spec.items() if k != "document"}
    document = spec["document"]
    out = {"input": cleaned, "ms": inference_ms, "total_ms": round((time.perf_counter() - started) * 1000),
           "tokens": tokens, "queries": queries, "words": words, "layers": layers,
           "word_vectors": word_vectors, "rnn": rnn_data, "spatial": spatial_data,
           "stages": stages, "result": rounded(result, 6), "embeddings": embeddings,
           "document": document, "provenance": {"model": MODEL_ID, "revision": INFO["revision"],
               "source_revision": SOURCE_REVISION, "attention": "eager; mean across heads; individual query-to-word heads also included",
               "projection": "3D PCA of normalized hidden states, aligned between successive layers",
               "displayed_dimensions": 32, "hidden_dimensions": INFO["hidden"], "layout_used": spatial_data is not None,
               "pixels_consumed": False}}
    trace.data.clear()  # release tensors after serializing the trace
    return out


class Handler(BaseHTTPRequestHandler):
    timeout = 60

    def send_bytes(self, code, data, kind):
        compressed = "gzip" in self.headers.get("Accept-Encoding", "") and len(data) > 1000
        if compressed:
            data = gzip.compress(data, 5)
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Vary", "Accept-Encoding")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(data)

    def json(self, code, obj):
        self.send_bytes(code, json.dumps(obj, ensure_ascii=False, allow_nan=False).encode(), "application/json; charset=utf-8")

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/info":
            return self.json(200, INFO)
        if path == "/api/examples":
            return self.json(200, EXAMPLES)
        if path == "/api/document/example":
            return self.json(200, example_document())
        files = {"/": ("index.html", "text/html"), "/index.html": ("index.html", "text/html"),
                 "/app.js": ("app.js", "text/javascript"), "/style.css": ("style.css", "text/css"),
                 "/lessons.js": ("lessons.js", "text/javascript"),
                 "/walkthrough.js": ("walkthrough.js", "text/javascript"),
                 "/examples.json": ("examples.json", "application/json"),
                 "/vendor/three.module.js": ("vendor/three.module.js", "text/javascript"),
                 "/vendor/OrbitControls.js": ("vendor/OrbitControls.js", "text/javascript")}
        files["/vendor/RoundedBoxGeometry.js"] = ("vendor/RoundedBoxGeometry.js", "text/javascript")
        if path in files:
            file, kind = files[path]
            return self.send_bytes(200, (HERE / file).read_bytes(), kind + "; charset=utf-8")
        return self.json(404, {"error": "Not found"})

    def do_POST(self):
        path = urlsplit(self.path).path
        if path not in ("/api/analyze", "/api/document"):
            return self.json(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 15 * 1024 * 1024:
                raise ValueError("Send at most 15 MB of JSON.")
            body = json.loads(self.rfile.read(size))
            if path == "/api/document":
                if not isinstance(body, dict):
                    raise ValueError("Send a JSON object.")
                return self.json(200, read_document(body))
            spec = validate(body)
            if not LOCK.acquire(blocking=False):
                return self.json(429, {"error": "The model is analyzing another sentence. Try again in a moment."})
            try:
                out = analyze(MODEL, TRACE, spec)
            finally:
                LOCK.release()
            self.json(200, out)
        except (ValueError, TypeError, KeyError, OverflowError) as exc:
            self.json(400, {"error": str(exc)})
        except Exception as exc:
            traceback.print_exc()
            self.json(500, {"error": f"{type(exc).__name__}: {exc}"})


def check():
    reports = []
    for task in EXAMPLES:
        body = dict(EXAMPLES[task][0])
        if task == "document":
            body["document"] = example_document()
            body["text"] = body["document"]["text"]
        out = analyze(MODEL, TRACE, validate(body))
        assert len(out["layers"]) == INFO["layers"] + 1
        assert all(len(layer["attention"]) == len(out["tokens"]) for layer in out["layers"][1:])
        assert all(out["input"]["text"][w["start"]:w["end"]] == w["text"] for w in out["words"])
        if task == "document":
            assert out["spatial"] is not None and out["provenance"]["layout_used"]
        if task == "embedding":
            assert len(out["embeddings"]["vectors"][0]) == INFO["hidden"]
        if task == "classification":
            assert out["stages"]["classes"]
        if task == "structure":
            assert out["stages"]["records"]
        if task == "relations":
            assert out["stages"]["bio"] and "joint_relex" in out["result"]
            assert all(p["relation"] in body["relations"] for p in out["stages"]["pairs"])
        reports.append(f"{task}: {len(out['tokens'])} tokens, {out['ms']} ms")
    print("OK: " + "; ".join(reports), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=MODEL_ID)
    parser.add_argument("--revision", default=MODEL_REVISION)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8766, type=int)
    parser.add_argument("--threads", default=4, type=int)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    torch.set_num_threads(max(1, args.threads))
    print(f"Loading {args.model}@{args.revision[:8]}…", flush=True)
    MODEL, revision = load_model(args.model, args.revision, args.offline)
    INFO = model_info(MODEL, args.model, revision)
    TRACE = Trace(MODEL)
    if args.check:
        check()
    else:
        print(f"Ready: http://{args.host}:{args.port} ({INFO['params']:,} parameters)", flush=True)
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
