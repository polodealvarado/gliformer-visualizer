# GLiFormer Large v1: the complete text and layout path

This analysis describes the checkpoint executed by the visualizer, rather than every architecture supported by the GLiFormer framework.

| Artifact | Pinned version |
|---|---|
| Checkpoint | `knowledgator/gliformer-large-v1@d0a4e53d09cebe6bc963dd9be319d4279084bb2d` |
| Framework | `Knowledgator/GLiFormer@73d1dad5ebf1f34a00339f023b1fd77a6d1f386a` |
| Parameters | 575,637,510 |
| Backbone | Layout DeBERTa, initialized by the checkpoint’s saved encoder configuration |
| Transformer layers | 24 |
| Attention heads | 16 per layer |
| Hidden width | 1,024 |
| Feed-forward intermediate width | 4,096 |
| Vocabulary | 128,008 |
| Source word pooling | First subword |
| Word RNN | One bidirectional LSTM layer |
| Trained task heads | NER, classification, joint relations, structuring, embeddings |

The model’s saved `gliner_config.json` is the source of these settings. `/api/info` reports the runtime configuration and package versions.

## 1. Text and task schema

The processor writes the requested tasks into the encoder prompt. Label text is part of the inference input. Entity types, class labels, relation types and structure fields can therefore change without replacing the output vocabulary or retraining a fixed classifier.

The checkpoint’s marker roles are:

| Marker | ID | Role |
|---|---:|---|
| `[ENTITY]` | 128001 | Entity type |
| `[SCHEMA]` | 128002 | Parent/group context |
| `[CLASS]` | 128003 | Whole-text classification option |
| `[RELATION]` | 128004 | Directed relation type |
| `[FIELD]` | 128005 | Structure field |

The app derives IDs from the loaded configuration. It displays the exact tokenizer sequence, including the framework’s separators, rather than reconstructing a schematic prompt.

One joint entity/relation group supplies both kinds of labels when relations are requested. Supplying a second duplicate entity group can expose padded relation rows in the upstream decoder; the app avoids creating that redundant group.

## 2. Document text and layout

The page image follows one of two paths:

1. A PDF with embedded text supplies exact words and their page rectangles through PyMuPDF.
2. An image or scanned PDF supplies words and rectangles through local Tesseract OCR.

The app normalizes each rectangle to `[x0,y0,x1,y1]` in a 0–1000 coordinate system. It creates one source text with preserved character offsets, then calls the model’s own word splitter.

The model may split a PDF word into several units, particularly around punctuation. Each model unit receives the union of source boxes overlapping its character range. The processor subsequently aligns these boxes to subwords.

This avoids assuming that OCR words and model words have identical indices. It also lets the decoder map results back to the exact source text.

The encoder receives:

| Tensor | Shape | Meaning |
|---|---|---|
| `input_ids` | `[1,T]` | Prompt and source subwords |
| `attention_mask` | `[1,T]` | Real sequence positions |
| `bbox` | `[1,T,4]` | Subword-aligned boxes |
| `layout_input_mask` | `[1]` | Whether layout is active for this item |
| `page_token_ids` | `[1,T]` | Page indices |
| `page_input_mask` | `[1]` | Whether page embeddings are active |

The captured `bbox` is the actual encoder input. Disabling word positions omits document boxes and page IDs before a new forward pass.

**No image-pixel features enter this checkpoint.** The page image remains available in the UI so readers can inspect geometry. The framework’s vision and audio variants require other checkpoint configurations and weights.

Source: [`LayoutProcessingMixin`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/processing/processor.py), [`LayoutDebertaEmbeddings`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/backbones/deberta_2d.py).

## 3. Tokenization and embeddings

The app loads the checkpoint’s saved Rust Unigram tokenizer directly. This preserves its normalizer, segmentation, special IDs and postprocessor while avoiding an unnecessary reconstruction of the 128,000-entry vocabulary during startup.

`words_mask` relates source pieces to model word units. Prompt and special-token positions have no source word. The first source subword supplies a word representation after the encoder.

The input embedding block:

```text
token ID → learned word vector
         + optional spatial vector
         + optional page vector
         → LayerNorm → dropout (disabled in eval mode)
```

The spatial representation combines learned coordinate and box-shape embeddings. Coordinate width is 128 and shape width is 64; the resulting spatial vector has width 1,024.

The checkpoint does not add absolute 1D sequence-position embeddings. DeBERTa handles relative sequence position inside attention. Absolute 2D layout information enters through the spatial embeddings.

## 4. The 24 Transformer layers

Each layer runs disentangled self-attention, residual/normalization operations and a feed-forward block. There are 16 heads with a 1,024-dimensional combined representation and a 4,096-dimensional intermediate feed-forward projection.

The saved configuration uses content-to-position and position-to-content relative attention. Its learned relative 2D layout-attention bias is disabled. Do not describe ordinary sequence-relative attention as active relative document-layout attention.

The visualizer requests eager attention and captures:

- Embedding output plus 24 hidden-state outputs: 25 snapshots of `[1,T,1024]` internally.
- Full mean token-to-token attention for each layer: `[T,T]`.
- Per-query attention to source words, for each of 16 heads: `[16,Q,W]`.
- Query-to-word cosine similarity computed from the full hidden vectors: `[Q,W]`.

Attention to a word is the sum of attention to its subwords. In the individual-head scene, that aggregated value is drawn on the word’s first piece; the panel lists the word-level values explicitly.

Attention is an observation of information mixing. It is not an intervention, a causal attribution, or evidence that one input token determined an answer.

Source: [`LayoutDebertaModel`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/backbones/deberta_2d.py).

## 5. Word features and the bidirectional LSTM

The model collects first-subword features for source words. Its one-layer bidirectional LSTM then updates those features in both source-order directions.

Each direction has 512 hidden units. Their per-word outputs are concatenated, so the shape remains `[1,W,1024]`. Schema marker embeddings remain available separately. A hook captures the word-RNN input and output, allowing the selected word’s displayed dimensions to be compared before and after recurrence.

The beginner view illustrates two readers carrying numerical summaries. Its arrows and replay markers show reading order, not measured gates or cell states. The input/output strips remain captured tensors. The saved first 32 output dimensions lie in the forward half; backward output starts at dimension 512. No previous hidden state is supplied, so memory starts afresh per sentence.

The raw Transformer [CLS] vector used by classification is distinct from these recurrent source-word features.

Source: [`_apply_word_rnn`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/model.py).

## 6. Parent anchors and label conditioning

For NER and classification, the parent schema marker supplies an anchor. `LinearAnchorModeling` concatenates it with each child label embedding and projects `2048 → 1024`.

This conditions each label on its task group. It is not the fixed list of record slots used later by structuring.

The visualizer captures fused anchor/label outputs from the normal modules. Shared NER modules can be called for entity extraction and again for structuring fields; a trace explicitly identifies the head and records the first observed fused vectors.

Source: [`AnchoredSpanExtractionHead`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/tasks/anchored_extraction.py), [`LinearAnchorModeling`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/layers/anchor_modeling.py).

## 7. Named entities

`AnchoredSpanScorer` projects question and source-word vectors, combines them in an MLP and produces three logits per word and entity type:

```text
ner_logits: [groups,W,entity types,3]
last axis:  start, end, inside
```

Sigmoid produces the displayed probabilities. The decoder pairs start and end positions of the same type. Every inside word must pass the threshold. The candidate’s score is the minimum of its start/end/inside evidence and the complementary inside evidence immediately outside its boundaries, where those positions exist.

A greedy search resolves overlaps. The app uses `flat_ner=True`. Internal word ends are inclusive; final character ends are exclusive. The displayed entity must satisfy `text[start:end] == entity.text`.

There is no GLiNER2.5 gap encoder, shared boundary candidate pool, null-abstention head or record anchor-span decoder in this checkpoint.

Source: [`NERHead`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/tasks/ner/model.py), [`SpanDecoder`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/tasks/span_decoder.py).

## 8. Whole-text classification

The classification head combines parent and class vectors, then scores each against the encoder’s raw [CLS] representation:

```text
label score = dot(CLS, conditioned class vector)
probability = sigmoid(label score)
```

Scores are independent and do not sum to one. The decoder selects every above-threshold class in multilabel mode, or the highest class if it exceeds the threshold in single-label mode.

It does not use a softmax and does not pool the first source word as [CLS].

Source: [`ClassificationHead`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/tasks/classification/model.py), [`ClassificationDecoder`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/tasks/classification/decoder.py).

## 9. Joint relation extraction

This checkpoint uses the joint relation head. The separate convenience method for open relations requires an open relation head, which this checkpoint does not contain.

The joint route:

1. Reuse NER scores to select typed entity spans.
2. Pool each span using the configured marker-based representation.
3. Build directed head/tail pairs.
4. Concatenate and project pair features with the default pair MLP.
5. Compare pairs with contextualized `[RELATION]` vectors.
6. Apply sigmoid and decode above-threshold typed links.

The checkpoint has null `relations_layer` and `triples_layer`. It therefore has no separate learned adjacency-filter layer. The existence of a joint head and a relation scorer does not imply that every configurable pair-selection strategy is active.

The trace resolves `joint_rel_idx` against `joint_rel_entity_spans`, preserving the model’s actual endpoint candidates. It includes accepted and rejected scores.

Source: [`JointRelexHead`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/tasks/joint_relex/model.py).

## 10. Structured and nested records

The composite structuring head contains several distinct decisions.

**Field extraction.** A NER-style route produces field-specific start/end/inside scores. The model coalesces extracted field spans and pools their representations. Field evidence has shape `[groups,candidates,fields]` and is derived from the BIO evidence.

**Record slots.** The fixed anchor layer starts with 100 learned slots, shifted by gated schema context. Center-RMS normalization, Fourier query/memory positions, Gaussian distance bias and two eight-head cross-attention refinement layers condition the slots on the source.

**Objectness.** Each slot has a logit for whether a record exists: `[groups,100]`.

**Membership.** Each source candidate is scored against each slot: `[groups,100,candidates]`. This determines which values belong together. It is separate from field-type evidence.

**Hierarchy.** An MLP scores directed anchor-to-anchor connections: `[groups,100,100]`. This layer already applies sigmoid; the visualizer must not apply a second sigmoid.

**Decoding.** The multilevel decoder combines schema paths, field evidence, membership, objectness and anchor links. It can discard empty records and deduplicate records. Raw anchor connections are distinct from the final selected parent–child tree.

The framework’s anchor diagnostics expose activated physical anchors, logical anchors and selected hierarchy connections. The app preserves these alongside the final nested JSON.

Source: [`StructuringHead`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/tasks/structuring/model.py), [`structuring decoder`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/processing/structuring_decoder.py).

## 11. Sentence embeddings

`embed_text()` is a separate path through the shared encoder weights. It tokenizes raw sentences without task prompts. The embedding head projects token features through its trained MLP, then performs CLS pooling to return `[sentences,1024]`.

It bypasses the extraction word LSTM. Prompted extraction states must not be presented as equivalent sentence embeddings.

Cosine similarity is computed using the full returned vectors. Negative cosine values are valid. The token meaning map, by contrast, shows a PCA projection of encoder hidden states and is not the pooled sentence-embedding space.

Source: [`embed_text`](https://github.com/Knowledgator/GLiFormer/blob/73d1dad5ebf1f34a00339f023b1fd77a6d1f386a/gliformer/gliformer.py).

## 12. Capture and presentation contract

| Display | Captured source |
|---|---|
| Exact input pieces | Model batch `input_ids` and saved tokenizer |
| Word offsets | Model `prepare_inputs()` mappings |
| Actual layout inputs | Encoder `bbox` and spatial embedding module |
| Layer vector strips and PCA | Real encoder hidden states |
| Attention arcs and matrices | Real eager-attention outputs |
| Word vectors before/after recurrence | Forward hook on the word LSTM |
| Fused schema questions | Forward hooks on anchor-modeling modules |
| Entity/field BIO scores | Actual model head logits, followed by sigmoid |
| Class scores | Actual classification logits, followed by sigmoid |
| Relation candidates | Pair indices, entity spans and relation logits |
| Record objectness/membership | Structuring output tensors |
| Anchor links | Structuring anchor-relation scores |
| Final answers | Unmodified framework inference result |
| Static examples | The same live API, recorded by `bake.py` |

The server observes normal framework inference. It requests additional encoder outputs, uses forward hooks, serializes one inference at a time and releases captured tensors after creating the JSON trace.

The presentation compresses data in explicit ways: 32-dimensional display strips, rounded numbers, mean token attention and a three-dimensional PCA projection. It retains all 100 slot scores, full sentence embeddings and captured candidate scores in downloadable traces. It does not export all 1,024 hidden dimensions for every layer.

Timings distinguish model inference from total trace preparation. The app’s measurements describe short examples on the current host, not a benchmark or throughput guarantee.


## Visual conventions shared with Inside GLiNER2.5

The interface reuses the original visualizer's top composer, Inter/Playfair Display/IBM Plex Mono typography, stage descriptions and three explanation tabs.
The original local `index.html` was verified byte-for-byte against the deployed Hugging Face Space on 2026-11-02 (SHA-256 `b4f24cba07551c558aadaa52050786b1b90c55a25074cc9de3e60a73a6c68920`).

`walkthrough.js` adapts the original plate geometry, canvas text, row layout, source-span labels, camera fitting, stage fading and transition particles.
Words retain their relative horizontal positions between word-level stages. Complete entities share one type color and one score label over the full mention.
Previous plates remain faintly visible; later plates fade away. Token plates separate prompt groups from the source sentence.

GLiFormer-specific builders show word start/end/inside scores, the word LSTM, parent-anchor conditioning, directed entity pairs, fixed record slots, membership, hierarchy and document geometry.
They do not introduce GLiNER2.5 gap vectors, shared boundary pools or span-anchored record instances.
Sentence embeddings and the meaning map retain their separate numerical contracts described above.
