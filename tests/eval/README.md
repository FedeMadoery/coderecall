# Eval probes

Measurement scripts for retrieval quality. They produced the findings in
`docs/plan/IMPROVEMENT-PLAN.md` and are the seed for the Phase 0 eval harness —
not the harness itself: there are no assertions yet.

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
    "sha": null
  },
  "queries": [
    { "kind": "topic",      "q": "how does request retry work" },
    { "kind": "definition", "q": "RetryPolicy" },
    { "kind": "knowledge",  "q": "why did we drop the old scheduler" },
    { "kind": "definition", "q": "does_not_exist", "note": "must NOT expand" }
  ]
}
```

Pick a corpus that is a **live coderecall install** — a repo with an existing
`.coderecall/index.db` and, ideally, accumulated `add_knowledge` entries. This
repo is a poor corpus: small, TypeScript-only, no knowledge entries.

`CODERECALL_EVAL_CORPUS` overrides `corpus.root`.

## Running

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
