# coderecall improvement plan

Four workstreams, each gated by a research spike that must produce a written answer
before any implementation starts. Ordered so that measurement exists before the
things being measured change.

| # | Workstream | Why now | Est. |
|---|---|---|---|
| 0 | Retrieval eval harness | ✅ **DONE** — 32 labelled queries, baseline recorded | shipped |
| 5 | Deletion/rename pruning in full `index` | ✅ **DONE** — 16% → 0% phantom results | shipped |
| 1 | Embedding model | ✅ **DONE** — premise refuted; switched to arctic-embed-s instead | shipped |
| 2 | Intent routing + tier recalibration | ✅ **DONE** — MRR 0.802→0.926, full precision 57→83% | shipped |
| 3 | `search_history` (git-backed, index-free) | Independent; closes a visible gap vs code-memory | 1 d |

---

## Measured baseline (eval corpus, 2026-08-24)

All numbers below come from a live coderecall install on a private polyglot
project, measured read-only against a copy of its index. That project is the
eval corpus for every phase — it has real accumulated knowledge entries, unlike
this repo. Its location is local configuration, not part of this repo: set
`CODERECALL_EVAL_CORPUS` and see `tests/eval/README.md`.

| Property | Value |
|---|---|
| Indexed files | 416 (302 Python, 111 TypeScript, 3 JS) |
| Code chunks | 2,562 (1,599 function, 579 method, 227 class, 100 module, 57 block) |
| Knowledge entries | 78 |
| Embeddings | 2,640, all 384-D |
| `last_index_run` | 2026-08-05 — 19 days stale, banner currently firing |

### Finding A — the index is 7.5% phantom, and it pollutes 16% of results

31 of 416 indexed files no longer exist in the repo; they carry **274 of 2,562
chunks (10.7%)**. Across the 15 queries in the committed fixture:

- **7 of 15 queries** returned at least one deleted file
- **16 of 98 code results (16.3%)** pointed at a file that is gone
- several were expanded at **`full` tier** — the agent receives the complete
  contents of a deleted file, labelled high-confidence

The offenders were ordinary churn: modules deleted in a refactor, a superseded
cron job, one-off evaluation scripts. All deleted, all still being served. This
is worse than a missing result: it is confidently wrong context. Phase 5 is therefore the highest-value fix in the
plan, not a papercut.

Two files from the newest commit are also missing from the index, consistent
with the 19-day-old `last_index_run`.

### Finding B — the tier thresholds only look correct because two bugs cancel

Measured over the fixture, the top result's `finalScore` was
min 0.491 / mean 0.725 / max 0.795 — so results *do* reach the 0.7 `full`
threshold, which **refutes the earlier hypothesis** that code chunks almost
never get fully expanded.

The reason they reach it is not reassuring. `top_kw` was **exactly 1.000 for
every one of the 14 queries that matched anything at all**, because
`keywordSearch` normalizes FTS5 rank by the top row's own rank. So the keyword term contributes its full 0.3 weight to nearly every query,
which is what lifts a typical hit from ~0.5 into the `full` band — compensating
for the flat `+0.1` that code chunks get from the missing-recency default.

**Consequence for sequencing: fixing the FTS normalization alone would collapse
the `full` tier.** The normalization fix, the recency asymmetry, and the
thresholds have to be recalibrated in one pass, against measured percentiles.

### Finding C — knowledge entries dominate the top slot

Knowledge took top-1 in **6 of 10** queries, including code-shaped ones. Causes:
knowledge entries get a real `calculateRecencyBoost` while code chunks get the
0.5 default, and `rerank` adds +0.1 for architecture-flavoured queries. Decide
whether this is the intended bias — for "how does X work" it probably is; for
`definition` queries it is not.

### Finding D — graceful degradation already works

`build_prompt` (a symbol that does not exist in the corpus) produced zero FTS
hits, scored 0.491, and returned **0 full / 10 summary / 0 metadata**. The
tiering correctly refused to expand anything. Keep this as a regression test.

Also refuted while checking: there is **no** snake_case FTS bug — a
snake_case symbol that *does* exist scores `top_kw = 1.000`. FTS5 handles
underscored identifiers as adjacent-token phrases correctly.

### Note — vendored drift

The corpus's vendored `tools/coderecall/src` differs from this repo's HEAD in
`indexer/obsidian.ts` and `mcp/server.ts`. Re-vendor before measuring, or the
baseline describes code that no longer exists here.

---

## Phase 0 — Retrieval eval harness (prerequisite)

> **Status: shipped 2026-08-24.** `tests/eval/run.ts` (+ `bun run eval`), 32
> hand-labelled queries pinned to a corpus SHA, ground truth read from the
> corpus source rather than from coderecall's own output. Metrics: hit@10,
> recall@10, MRR, P@1, full-precision, false-confidence, and a negatives check.
>
> **Baseline (bge-small-en-v1.5, 2,301 code chunks + 78 knowledge entries):**
>
> | kind | n | hit@10 | recall@10 | MRR | P@1 | full precision |
> |---|---|---|---|---|---|---|
> | definition | 12 | 100.0% | 100.0% | 0.825 | 75.0% | 47.4% |
> | knowledge | 8 | 100.0% | 81.3% | 0.742 | 62.5% | 25.0% |
> | topic | 10 | 100.0% | 75.0% | 0.764 | 60.0% | 37.2% |
> | **overall** | **30** | **100.0%** | **86.7%** | **0.783** | **66.7%** | **36.0%** |
>
> false confidence 0/30; negatives 0/2 expanded — both clean.
>
> Two things this immediately tells us, and one caveat:
>
> - **`full precision` is 36%.** Nearly two thirds of the results that get
>   expanded to full content are not answers to the question. The tiering
>   feature is spending most of its context budget on wrong results — a much
>   sharper statement of the Finding B calibration problem than the score
>   distribution alone, and the metric Phase 2 should be judged on.
> - **Symbol lookup is already strong** (definition recall 100%, MRR 0.825), so
>   Phase 2's `definition` fast path is about precision at rank 1 (75%) and
>   tier assignment, not about finding the symbol at all.
> - **Caveat: `hit@10` is saturated at 100%** and cannot show improvement. It is
>   a regression detector only. Judge Phases 1 and 2 on recall@10, MRR, P@1, and
>   above all full precision. If a later change needs more headroom, tighten the
>   ground truth (require `::name` on topic queries) rather than reading a
>   ceiling as success.

Without this, items 1 and 2 are vibes. Both change ranking behaviour, and both
claims ("code embeddings are better", "these thresholds are right") are only
meaningful against a fixed set of queries with known-good answers.

### Research

1. Build a fixture set of 25–30 `query → expected result` pairs against the
   **eval corpus**, not this repo: 416 files, 2,562 chunks, 78 knowledge
   entries, Python-dominant, so it exercises the Python parser and the knowledge
   path rather than only TypeScript. Cover the three query shapes we care about:
   topic discovery, definition lookup, and knowledge recall. The probe queries
   used for the baseline above are the seed set; they live in the gitignored
   `tests/eval/.local/queries.json` because they name private project
   internals.
2. Decide the metrics. Proposal: **recall@10**, **MRR**, and a
   **tier-correctness** rate (was the expected chunk returned at `full` when it
   was the right answer, rather than demoted to `metadata`).
3. Decide where fixtures live so they survive a reindex: they must key on
   `filepath + name`, **not** on `chunk.id` — chunk ids are regenerated on every
   reindex (`addCodeChunk` mints a fresh id).
4. **Pin the corpus to a commit.** The corpus is an active repo; an eval whose
   corpus moves under it is not a baseline. Record the corpus SHA in
   `baseline.json` and reindex from that SHA. Never measure against a live
   `.coderecall/index.db` in place — copy it, as the baseline run above did.
5. Decide how knowledge entries enter the eval index. The 78 entries live only in
   that developer's local DB and are not reproducible from a git checkout;
   export them to a fixture file so the harness is repeatable on another machine.
   That export stays **gitignored** — it is the project's private architecture
   notes, and this repo is public.

### Implementation

- `tests/eval/fixtures.json` — the query set.
- `tests/eval/run.ts` — builds a throwaway index into a temp dir, runs both
  `search()` and `tieredSearch()`, prints a metrics table, and writes
  `tests/eval/baseline.json`.
- `bun run eval` script in `package.json`.

### Exit criteria

A committed baseline for the current `bge-small-en-v1.5` setup. Every later phase
reports its delta against that number.

---

## Phase 5 — Prune deleted and renamed files on full `index`

> **Status: shipped 2026-08-24.** `listCodeFilepaths()` +
> `CodeChunker.indexFiles(files, { prune })`, gated on scan-root ==
> project-root in both the CLI and MCP layers, with an empty-scan guard.
> 7 tests in `tests/prune.test.ts`. Verified on the eval corpus: 31 files / 274
> chunks pruned in 1.2 s, phantom results **16.3% → 0.0%**, all 78 knowledge
> entries intact, `embeddings == memory_fts == chunks` with no orphans.
> Two design notes that came out of the work:
> - `deleteCodeFile` already invalidated the in-memory vector cache
>   (`cacheRemove`), so no fix was needed there — pruning takes effect inside a
>   running MCP server without a restart. Covered by a test.
> - Scoped pruning was **dropped** from scope. `FileScanner` stores paths
>   relative to its `basePath`, so `coderecall index ./frontend` records
>   `src/api/foo.ts` rather than `frontend/src/api/foo.ts` — scoped paths are
>   indistinguishable from root-relative ones, which makes `scopePrefix`
>   pruning unsound. **That path-relativity bug is still open** and worth its
>   own fix; it also means scoped indexing silently pollutes the index with
>   wrong paths today. No evidence it has been used on the corpus.

**Measured impact (see Finding A): 31 phantom files, 274 dead chunks, 16% of
code results in a live project point at deleted files — some at `full` tier.**

Today `coderecall index` never removes anything. `indexFile` skips unchanged
files by content hash and `deleteChunksForFile` handles *modified* files, but a
file deleted or renamed on disk keeps its chunks, its FTS rows, and its vectors
forever. They keep scoring and keep being returned. The README documents this
hole; it is also the single cheapest fix in this plan, and it must land before
Phase 0's baseline is trusted.

### Research

1. Confirm the delete path is complete: `deleteCodeFile(filepath)`
   (`src/storage/database.ts:140`) removes the `code_files` row, its chunks, and
   each chunk's `memory_fts` + `embeddings` rows. Verify the in-memory
   `embeddingsCache` is invalidated too (`cacheRemove`) — a stale cache would
   keep serving vectors for pruned chunks inside the same process.
2. Decide how to distinguish a **full scan** from a **partial scan**. This is the
   whole design risk: `index_files(paths: [...])` and
   `coderecall index src/search` are legitimately partial, and pruning on a
   partial scan would delete the rest of the index. Proposal: pruning is opt-in
   via an explicit `prune` option, and the caller only sets it when it knows the
   scan covered a whole subtree — plus a `scopePrefix` so a scoped run only
   prunes within its own subtree.
3. Confirm `git ls-files --cached --others --exclude-standard` never omits a file
   that is genuinely still present (e.g. a file that just became gitignored).
   Such a file *should* be pruned — it left the index's definition of the repo —
   but the log line must say so, because it looks like data loss otherwise.

### Implementation

- `MemoryDatabase.listCodeFilepaths(): string[]` — new method, trivial select.
- `CodeChunker.indexFiles(files, opts?: { prune?: boolean; scopePrefix?: string })`:
  after the loop, if `prune`, diff `listCodeFilepaths()` against the scanned set
  and `deleteCodeFile` the difference (restricted to `scopePrefix` when set).
- Return `files_pruned` in `IndexFilesResult`; add it to `IndexFilesResult` in
  `src/types/index.ts`.
- Wire `prune: true` in the CLI `index` command (`scripts/cli.ts:148`) only when
  no path positional was given, i.e. a whole-project scan. Add `--no-prune`.
- Leave `index_files` (MCP) unpruned by default; it takes arbitrary paths.
- Print `Files pruned: N` and list the paths at `--verbose`.

### Verification

Unit level: index the repo, `git mv` a file, reindex, assert the old path returns
zero results and `listCodeFilepaths()` no longer contains it. Then assert a
scoped `coderecall index src/search` leaves `src/indexer/*` intact.

Corpus level: re-run the Finding A measurement against the corpus after a pruning
reindex. Exit criterion is **0 phantom files, 0 dead chunks, 0% phantom results**
— the same probe that produced 31 / 274 / 15.9% must come back clean.

---

## Phase 1 — Embedding model (premise refuted)

> **Status: shipped 2026-08-24.** The hypothesis behind this phase — that a
> code-trained model is the biggest available quality lever — **did not survive
> measurement**. The code model lost. Two other things in this phase did win.
>
> ### Four-way comparison (same corpus, same fixture, same thresholds)
>
> | | bge no-prefix | bge + prefix | **arctic-s** | jina-code |
> |---|---|---|---|---|
> | dim / download | 384 / 34 MB | 384 / 34 MB | **384 / 34 MB** | 768 / 162 MB |
> | index build (2,301 chunks) | — | 85 s + 4 s | **87 s + 5 s** | 682 s + 285 s |
> | hit@10 | 100.0% | 96.7% | **100.0%** | 100.0% |
> | recall@10 | 86.7% | 88.3% | **91.1%** | 86.1% |
> | MRR | 0.783 | 0.800 | **0.802** | 0.732 |
> | P@1 | 66.7% | 70.0% | **70.0%** | 63.3% |
> | full precision¹ | 36.0% | 41.9% | 57.1% | 41.2% |
>
> ¹ **Not comparable across models.** Tier thresholds (0.7/0.4) are fixed, but
> each model has its own score distribution — mean top score was 0.744 (bge),
> 0.687 (arctic), 0.679 (jina). A model that scores lower expands less often,
> which mechanically inflates its precision. Judge Phase 1 on the
> threshold-independent metrics; `full precision` becomes comparable only after
> Phase 2 calibrates thresholds per distribution.
>
> ### Decisions
>
> **1. Query prefixes: adopted.** bge is trained asymmetrically and coderecall
> applied no prefix at all. Adding it (query side only) gained recall@10
> +1.7pp, MRR +0.017, P@1 +3.3pp on an unchanged index — the cheapest win in
> the whole plan. Now a per-model registry; unknown models get none, because a
> wrong prefix is worse than none.
>
> **2. Default switched to `Snowflake/snowflake-arctic-embed-s`.** Same 384-D
> width, same 34 MB, +2 s index time — and better on every
> threshold-independent metric (recall@10 +2.8pp, hit@10 +3.3pp, definition MRR
> 0.872 vs 0.836, definition P@1 83.3% vs 75.0%, knowledge recall 91.7% vs
> 81.3%). The gain is **modest, not dramatic**: overall MRR and P@1 are
> effectively flat, and hit@10's +3.3pp is one query out of 30. It is adopted
> because it is free, not because it is transformative. Existing indexes need
> one reindex, which the new compatibility check now tells users about.
>
> **3. `jina-embeddings-v2-base-code`: rejected.** It loads fine under
> `@xenova/transformers` v2.17 (the gating question — ALiBi `JinaBertModel`
> behind `model_type: "bert"` was not a problem, no v3 upgrade needed), but it
> ranks worse on this corpus while costing 5× the download and **10.8× the
> index time** (967 s vs 89 s). Worth recording: its *definition* full
> precision was 90% vs bge's 50% — it is genuinely good at symbol-level
> precision and bad at conversational topic queries (topic MRR 0.652 vs 0.813).
> If Phase 2's intent routing ever justified a per-intent model, that is the
> evidence — but it doubles the footprint on n=12, so not now.
>
> ### Also shipped
>
> - **Dimension is probed, not assumed.** It was hardcoded to 384, which is
>   exactly how a 768-D swap goes unnoticed.
> - **Model drift is detected.** `saveEmbedding` took a `model` argument that no
>   caller ever passed, so the column always claimed bge-small. All five call
>   sites now pass it, the index stamps model + width in `meta`, and startup
>   reports both width mismatches and same-width model changes. This closed a
>   silent-failure path where `cosineSimilarity` throws, `vectorSearch` swallows
>   it, and search degrades to keyword-only for the life of the process.
>
> ### Found, not fixed
>
> Knowledge entries are embedded **one at a time** while code chunks go through
> `embedBatch` — visible as 78 entries taking 285 s under jina vs 5 s under
> arctic. Worth batching in `markdown.ts` / `rules-importer.ts` regardless of
> model.

## Original research plan

`Xenova/bge-small-en-v1.5` is a general English retrieval model being asked to
embed source code. This is the weakest link in the hybrid: the
`keywordScore > 0.5` escape hatch in `mergeAndScore`
(`src/search/hybrid.ts:408`) exists precisely because vector-only recall is not
trustworthy today.

### Research findings so far (verified against the HF API, 2026-08-24)

| Candidate | Dim | Quantized ONNX | `transformers.js` tag | Notes |
|---|---|---|---|---|
| `jinaai/jina-embeddings-v2-base-code` | 768 | 162 MB | yes | Code-specific; `model_type: bert` + `position_embedding_type: alibi`, custom `JinaBertModel` via `auto_map`; mean pooling; 8192 ctx |
| `Snowflake/snowflake-arctic-embed-s` | 384 | 34 MB | yes | General text, but stronger than bge-small; **dimension-identical → drop-in** |
| `Xenova/bge-small-en-v1.5` (current) | 384 | 34 MB | yes | Baseline |
| `jinaai/jina-code-embeddings-0.5b` (what code-memory uses) | — | — | — | 0.5B params; out of budget for an in-process JS runtime |

So the real choice is: **162 MB + a dimension migration for a code-trained
model**, or **34 MB and no migration for a modestly better general model**. Note
that 162 MB is still ~4× smaller than code-memory's ~600 MB download.

### Research (must answer before implementing)

1. **Does `jina-embeddings-v2-base-code` actually load under `@xenova/transformers` v2.17?**
   This is the gating question and it is empirical. The config declares
   `model_type: "bert"` so transformers.js will route it to `BertModel`, but the
   architecture is ALiBi-based `JinaBertModel` and the exported graph may not
   accept the `token_type_ids` that the Bert path supplies. Spike: a ~15-line
   script that embeds two strings and prints `dims`. If it fails, test whether
   upgrading to `@huggingface/transformers` v3 (the renamed successor, where
   `quantized: true` becomes `dtype: "q8"`) fixes it, and price that upgrade
   separately.
2. **Query/document prefix asymmetry.** `embed()` applies no instruction prefix
   at all today. bge-small *and* arctic-embed both expect
   `"Represent this sentence for searching relevant passages: "` on the **query**
   side only; jina-code expects none. This is very likely a free recall win on
   the current model, independent of any swap — measure it as its own eval row
   before the swap, because it may change the swap's verdict.
3. **Chunk-side embedding text.** `embedChunks` concatenates
   `name + signature + docstring + content` capped at 8000 chars. A code model
   with an 8192-token window may prefer a different composition (e.g. path +
   signature first). One eval row, cheap to test.
4. **Quantized vs fp16.** q8 is 162 MB, fp16 is 321 MB. Measure both on the
   harness; only pay for fp16 if it actually moves the metric.

### Implementation

- **Make dimension dynamic.** `EmbeddingManager.dimension` is hardcoded to 384
  (`src/embeddings/manager.ts:6`); set it from the first embedding's real length
  and expose it.
- **Record model + dim in the index.** `saveEmbedding`'s `model` parameter
  defaults to the literal `"Xenova/bge-small-en-v1.5"` and **no caller ever
  passes it** — so the `model` column lies whenever a different model is
  configured. Fix the callers, and write `embedding_model` + `embedding_dim` into
  the `meta` table on `markIndexRun`.
- **Guard the mismatch.** Today a dimension change is a silent catastrophe:
  `cosineSimilarity` throws on length mismatch, `vectorSearch` catches it, logs
  `"Vector search failed"` to stderr, and returns an empty map — search silently
  degrades to keyword-only. On startup, compare configured model against
  `meta.embedding_model` and fail loudly with "reindex required", the same way
  the staleness banner works.
- Add a query-prefix field to the model registry so prefixing is per-model, not
  hardcoded.
- Update README: the "any other 384-D model is a drop-in" claim becomes
  "dimension is read from the model; changing it requires a reindex".

### Verification

Eval harness delta vs the Phase 0 baseline, reported as a table:
baseline / baseline+prefix / arctic-384 / jina-code-768. Note that a 768-D swap
grows this corpus's vector set from ~3.9 MB to ~7.8 MB in the brute-force
in-memory cache — still trivial at 2,640 chunks, but record the per-query
latency so the scaling limit is documented rather than assumed. Also record first-run download
size, cold init time, and per-chunk embed time — a quality win that triples
index time is a trade the README has to state honestly.

### Rollback

Model name is already config-driven (`embeddingModel`), so rollback is a config
change plus a reindex. Keep that documented rather than pretending the migration
is free.

---

## Phase 2 — Intent routing + tier recalibration

> **Status: shipped 2026-08-24.**
>
> | | arctic baseline | after Phase 2 |
> |---|---|---|
> | hit@10 | 100.0% | 100.0% |
> | recall@10 | 91.1% | **92.2%** |
> | MRR | 0.802 | **0.926** |
> | P@1 | 70.0% | **90.0%** |
> | full precision | 57.1% | **82.8%** |
>
> Per intent after: definition MRR 1.000 / P@1 100% / full precision 100%;
> knowledge 0.906 / 87.5% / 75.0%; topic 0.853 / 80.0% / 69.2%. False
> confidence 0/30 and negatives 0/2 throughout.
>
> ### What landed, and why it had to land together
>
> **Absolute keyword scores.** `keywordSearch` divided BM25 rank by the best
> rank *in the same result set*, so the top hit scored exactly 1.000 on every
> query — measured on 30 of 30. The keyword leg was a constant. Replaced with a
> saturating transform (`1 - exp(-|bm25|/10)`), K fitted to the measured
> distribution (p25 7.3, p50 9.0, p90 14.1, max 22.0).
>
> **Recency removed entirely.** It contributed up to 0.2, but only knowledge
> entries had a usable timestamp; code chunks hit a hardcoded 0.5 default and
> took a flat +0.1. It was never a recency signal — just a standing bonus for
> knowledge entries, and the direct cause of Finding C. `code_files.indexed_at`
> cannot substitute: it records when indexing ran, identical across a full
> reindex. Weights now sum to 1, so a score reads as a confidence.
>
> **Diversity penalty made live.** Candidates were all scored before the
> seen-files map was populated, so the penalty was always multiplied by zero.
> Selection is now greedy and incremental, re-scoring after each pick.
>
> These three shift the score scale, which is why the plan insisted on one
> atomic change: fixing the normalization alone would have collapsed the full
> tier, since its inflation was propping scores over a threshold tuned around it.
>
> **Thresholds fitted per intent, not guessed.** Sweeping correct-vs-incorrect
> score distributions produced two genuinely different pictures, which is the
> real argument for profiles:
>
> - `definition` **separates cleanly** — correct results 0.81–0.85, best wrong
>   result 0.757. A threshold at 0.78 captures every right answer at ~100%
>   precision.
> - `topic` **does not separate** — correct p10 0.531 / p50 0.646 versus wrong
>   p50 0.584 / p90 0.652. No threshold gets both precision and coverage, so it
>   expands few results at 0.68 (~71% precision, ~34% coverage) and lets the
>   summary tier carry the rest. Reaching 80% coverage would mean 34% precision:
>   spending most of the budget on wrong answers.
>
> **Intent routing.** `search_type: auto | definition | topic` on the MCP tool
> and `--search-type` on the CLI. `auto` infers from query shape and is
> deliberately conservative — only identifier-shaped queries route to
> `definition`, because misrouting a conceptual question is the costlier error.
> A `definition` query also gets an exact-chunk-name boost, since BM25 happily
> ranks a file that *mentions* an identifier above the one that *defines* it.
>
> ### Scope honesty
>
> - **`references` was dropped, as the research predicted.** Regex parsers give
>   no call graph, and naming a tool `references` that cannot answer "who calls
>   this" would be a lie. `file_structure` was also dropped: `get_file_context`
>   already covers it.
> - **Thresholds are fitted on the same 30 queries used to score, with no
>   held-out split, so the numbers are optimistic.** Widening the fixture and
>   refitting is the honest next step before quoting 83% anywhere load-bearing.
> - Thresholds are **not portable across embedding models**; a model whose
>   scores run lower expands less often. Changing `embeddingModel` should mean
>   re-running the calibration sweep.

## Original research plan

code-memory makes the agent choose a retrieval strategy *before* fetching
(`search_type: topic_discovery | definition | references | file_structure`).
coderecall instead guesses, weakly and after the fact: `detectQueryContext`
(`src/search/selector.ts`) regex-matches the query and then nudges the score by
±0.1 in `rerank`. The signal is real; the mechanism is too late and too small to
change which chunks are retrieved.

### Research (must answer before implementing)

1. **Which intents can we actually serve?** Honest inventory: with regex parsers
   we have `chunk_type`, `name`, `signature`, `visibility`, `parent_id`. That
   supports `definition` (exact/prefix name match on `code_chunks.name`),
   `topic_discovery` (today's hybrid path), and `file_structure` (already exists
   as `get_file_context`). It does **not** support `references` — we have no
   call graph. Decide explicitly: either omit `references` or ship it as an
   honestly-labelled text search. Do not name a tool after a guarantee the
   parsers cannot make.
2. **Calibrate the tiers — the scoring is currently mis-tuned.** Three findings
   from reading `selector.ts`, each to be confirmed with real numbers from the
   Phase 0 harness:
   - `selectWithDiversity` scores every candidate *before* the loop that
     populates `seenFilepaths`, so `fileCount` is always 0 and
     `diversityPenalty: 0.15` is **dead config**. Diversity comes solely from the
     hard `maxResultsPerFile` cap.
   - Code chunks never get an `updatedAt` (`getCandidateMetadata` returns it only
     for knowledge), so `calculateRecencyBoost` returns its 0.5 default and every
     code chunk gets a flat `+0.1`. Knowledge entries get a real decay — so code
     and knowledge are not scored on comparable scales.
   - `keywordSearch` normalizes FTS5 rank by the *top row's* rank, so the best
     keyword hit scores exactly 1.0 no matter how weak it is absolutely —
     **measured at 1.000 in 14 of 14 matching queries** (Finding B). The term is
     effectively a constant +0.3 whenever FTS returns anything.
   - These last two **cancel each other out**, which is why the measured top
     score is 0.725 mean and results do reach the 0.7 `full` band. The naive fix
     is a regression: correcting the FTS normalization alone drops ~0.3 off
     nearly every score and collapses the `full` tier. Treat normalization,
     recency, and thresholds as **one atomic recalibration**, and set thresholds
     from measured percentiles rather than round numbers.
   - Knowledge takes top-1 in 6 of 10 queries (Finding C). Decide per intent
     whether that bias is wanted — probably yes for `topic_discovery`, no for
     `definition`.
3. **Per-intent retrieval shape.** For each intent, decide pool multiplier,
   keyword/vector weights, `maxResultsPerFile`, and default expansion. A
   `definition` query wants exact-name-first, pool ~2×, and `full` on the top
   hit; `topic_discovery` wants today's 5× pool and strict diversity.
4. **Should the tool auto-route when the agent omits `search_type`?** Proposal:
   yes — keep `detectQueryContext` as the fallback so the tool stays
   single-argument for agents that ignore the parameter, but have it select a
   *retrieval profile* rather than apply a post-hoc boost.

### Implementation

- `src/search/profiles.ts` — one `RetrievalProfile` per intent (weights,
  thresholds, pool multiplier, diversity cap).
- `SelectionPolicy` takes a profile instead of a single frozen `DEFAULT_CONFIG`.
- Fix `selectWithDiversity` so the diversity penalty is applied during
  incremental selection (score → pick → update `seenFilepaths` → rescore the
  tail), making `diversityPenalty` live.
- Give code chunks a real `updatedAt` from `code_files.indexed_at`, or exclude
  code from the recency term and document why — the two source types must be
  comparable.
- `HybridSearch.tieredSearch(query, filter, limit, expansionMode, searchType?)`;
  add a `definition` fast path that queries `code_chunks.name` directly before
  falling back to hybrid.
- MCP: add `search_type` to the `search` tool (`src/mcp/server.ts:50`) with
  per-intent descriptions, since the tool description is the only thing steering
  the agent's choice. Add `--search-type` to the CLI.

### Verification

Harness per intent: `definition` queries should hit rank 1 near-always, since the
target symbol is named verbatim; `topic_discovery` recall@10
must not regress vs Phase 1. Report the tier distribution before/after so the
recalibration is visible, and keep the `build_prompt` case (Finding D) as a
regression test that a no-hit query still refuses to expand.

---

## Phase 3 — `search_history`: git-backed, no index

Pure win: no embeddings, no index, never stale. `FileScanner.getChangedFiles`
already shells out to git, so the pattern exists.

### Research

1. **Scope the modes.** Proposal: `commits` (search messages),
   `file_history` (commits touching a path), `blame` (who last touched
   lines N–M), `commit_detail` (one commit + its stat). Deliberately excluded:
   full-diff-content search (`git log -S`) — it is slow on large repos; add it
   later behind an explicit mode if asked for.
2. **Fix the injection surface — treat this as the phase's main risk.**
   `getChangedFiles` builds `git diff --name-status ${baseRef} ${headRef}` and
   feeds it to `execSync` with a shell. Those refs arrive from MCP tool
   arguments, i.e. from model output, so `HEAD; rm -rf ~` is a live command
   injection path *today*. All git calls (existing and new) move to
   `execFileSync("git", [...args])` with argv arrays and no shell, plus a
   validating allowlist on ref-shaped strings. Confirm `--` separators are used
   before every pathspec so a path starting with `-` cannot become a flag.
3. **Output budget.** These commands can emit megabytes. Decide caps up front:
   default `limit` (proposal: 20 commits), subject-line-only unless
   `commit_detail`, blame windowed to a line range, and a truncation notice in
   the payload — consistent with the confidence-tiering philosophy of not
   flooding the context window.
4. **Degrade gracefully outside git.** `isGitRepo()` exists; a non-repo must
   return a clear "not a git repository" message, not a stack trace. Also handle
   the shallow-clone case, where history simply is not present.

### Implementation

- `src/git/history.ts` — a `GitHistory` class wrapping `execFileSync`, one
  method per mode, returning typed results.
- Refactor `FileScanner.getChangedFiles` onto the same safe exec helper.
- Register a `search_history` MCP tool; add a `history` CLI command mirroring it.
- Types in `src/types/index.ts`; README tool table + comparison table updated.

### Verification

Unit tests against this repo's own history (it has real commits). Include an
explicit test that a ref like `"HEAD; touch /tmp/pwned"` is rejected and no file
is created.

---

## Sequencing summary

```
Phase 0 (harness + baseline)
   ↓
Phase 5 (prune)  ──────────────┐   independent of the model work
   ↓                          │
Phase 1 (embedding model)     │   Phase 3 (search_history)
   ↓                          │   can run in parallel at any point
Phase 2 (routing + recalibration)
```

Phase 2 must follow Phase 1: thresholds calibrated against bge-small's score
distribution would have to be thrown away after a model swap.

## Documentation debt to settle at the end

- Remove or wire up `sqlite-vec` — it is a declared dependency that no source
  file imports. `vectorSearch` brute-forces cosine over every cached vector.
  Fine at 5k chunks; state the limit or fix it, but stop shipping the implication.
- Add code-memory to the README comparison table with an honest split: they win
  AST depth, symbol references, and code-trained embeddings; coderecall wins the
  knowledge store, footprint, and tiered expansion.
