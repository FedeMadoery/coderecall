# Retrieval eval

`run.ts` is the harness: it scores `tieredSearch` against hand-labelled ground
truth and writes a baseline, so every later change to ranking, embeddings, or
tier thresholds can report a delta instead of a vibe. `probe-*.ts` are the
narrower diagnostic scripts that produced the findings in
`docs/plan/IMPROVEMENT-PLAN.md`.

The probes are corpus-agnostic. Everything that names a specific project lives
in `tests/eval/.local/`, which is **gitignored**: a useful corpus is somebody's
real repo with real architecture notes in it, and this repo is public.

## Setup

`tests/eval/.local/queries.json`:

```json
{
  "corpus": {
    "name": "my-corpus",
    "root": "~/path/to/some/repo",
    "sha": "<commit the ground truth was labelled against>"
  },
  "queries": [
    { "kind": "definition", "q": "RetryPolicy",
      "expect": ["code:src/net/retry.py::RetryPolicy"] },
    { "kind": "topic", "q": "how does request retry work",
      "expect": ["code:src/net/retry.py", "knowledge:Retry Strategy"] },
    { "kind": "knowledge", "q": "why did we drop the old scheduler",
      "expect": ["knowledge:Scheduler Replacement"] },
    { "kind": "negative", "q": "DoesNotExistAnywhere", "expect": [],
      "note": "must NOT expand anything to full" }
  ]
}
```

Expectation keys are one of:

| Key | Matches |
|---|---|
| `code:<path>` | any chunk in that file |
| `code:<path>::<name>` | that specific chunk |
| `knowledge:<title>` | that knowledge entry |

**Label ground truth from the corpus, not from coderecall's output.** Read the
source, grep for the symbol, look at knowledge titles. Recording what the tool
currently returns produces a baseline that can only ever score 100% and measures
nothing. An `expect: []` query is a negative: there is no right answer, and the
scoring asks only whether the ranker resisted expanding anything.

Pin `corpus.sha`. The corpus is a live repo; ground truth labelled against a
moving tree is not a baseline.

Pick a corpus that is a **live coderecall install** — a repo with an existing
`.coderecall/index.db` and, ideally, accumulated `add_knowledge` entries. This
repo is a poor corpus: small, TypeScript-only, no knowledge entries.

`CODERECALL_EVAL_CORPUS` overrides `corpus.root`.

## Running the harness

```bash
PROBE_DB=/tmp/eval/index.db bun run eval                       # score, print, don't save
PROBE_DB=/tmp/eval/index.db bun run eval -- --save             # write .local/baseline.json
PROBE_DB=/tmp/eval/index.db bun run eval -- --label jina-768   # name the run
```

Once `.local/baseline.json` exists, every run prints its delta against it.

### Metrics

| Metric | What it answers |
|---|---|
| `hit@10` | did any correct result make the top 10 |
| `recall@10` | what share of the ground-truth items were retrieved |
| `MRR` | how high the first correct result ranked |
| `P@1` | was the top result correct |
| `full precision` | of results expanded to **full content**, what share were correct — the token-budget question tiering exists to answer |
| `false confidence` | queries that found nothing correct yet still expanded something to full |
| `negatives` | queries with no right answer that expanded anyway (must stay 0) |

`full precision` is the one to watch. Retrieval can look healthy on recall while
spending most of the context budget on wrong results.

## Running the probes

**Always measure against a copy.** Opening a developer's live index read-write
risks their working index; the probes refuse to run against `<corpus>/.coderecall/index.db`.

```bash
CORPUS=~/path/to/some/repo
mkdir -p /tmp/eval && cp "$CORPUS/.coderecall/index.db" /tmp/eval/index.db

PROBE_DB=/tmp/eval/index.db bun run tests/eval/probe-scores.ts     # score + tier distribution
PROBE_DB=/tmp/eval/index.db bun run tests/eval/probe-phantoms.ts   # deleted-file pollution
```

`probe-phantoms.ts` needs `tests/eval/.local/phantoms.txt` — the paths that are
indexed but no longer in the working tree:

```bash
sqlite3 "file:$CORPUS/.coderecall/index.db?mode=ro" "select filepath from code_files;" \
  | LC_ALL=C sort > /tmp/db_files.txt
git -C "$CORPUS" ls-files -z --cached --others --exclude-standard | tr '\0' '\n' \
  | grep -E '\.(py|ts|tsx|js|jsx)$' | LC_ALL=C sort > /tmp/repo_files.txt
LC_ALL=C comm -23 /tmp/db_files.txt /tmp/repo_files.txt > tests/eval/.local/phantoms.txt
```

Match the `grep` extensions to the corpus's `.coderecall.json`.

`LC_ALL=C` matters on both sides: sqlite orders by bytes, `sort` orders by
locale, and mixing them silently yields a bogus diff where the same file appears
in both directions.

## Verifying a pruning reindex

Reindex the *copy*, leaving the developer's index alone:

```bash
CODERECALL_PROJECT_ROOT="$CORPUS" bun run scripts/cli.ts index --db /tmp/eval/index.db
PROBE_DB=/tmp/eval/index.db bun run tests/eval/probe-phantoms.ts   # expect 0.0%
```
