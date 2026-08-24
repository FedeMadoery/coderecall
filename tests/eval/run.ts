/**
 * Retrieval eval harness.
 *
 * Scores `tieredSearch` against hand-labelled ground truth and writes a
 * baseline. Every later change to ranking, embeddings, or tier thresholds
 * reports its delta against this — otherwise "did retrieval improve?" is
 * unanswerable.
 *
 * Corpus-agnostic: queries, expected results, and the baseline all live in
 * tests/eval/.local/ (gitignored). See tests/eval/README.md.
 *
 *   PROBE_DB=/tmp/eval/index.db bun run eval
 *   PROBE_DB=/tmp/eval/index.db bun run eval --label jina-768 --save
 */
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";

import { MemoryDatabase } from "../../src/storage/database";
import { EmbeddingManager } from "../../src/embeddings/manager";
import { HybridSearch } from "../../src/search/hybrid";
import { LOCAL_DIR, loadQueries, corpusSha, requireProbeDb, type EvalQuery } from "./corpus";

const LIMIT = 10;
const BASELINE_PATH = join(LOCAL_DIR, "baseline.json");

const argv = process.argv.slice(2);
const save = argv.includes("--save");
const labelIdx = argv.indexOf("--label");
const label = labelIdx >= 0 ? argv[labelIdx + 1]! : "baseline";

/** A result matches an expectation key: code:<path>, code:<path>::<name>, or knowledge:<title>. */
function keysFor(r: any): string[] {
  if (r.type === "code") {
    return [`code:${r.filepath}`, `code:${r.filepath}::${r.name}`];
  }
  return [`knowledge:${r.title}`];
}

interface QueryScore {
  kind: string;
  q: string;
  expected: number;
  found: number;
  firstHitRank: number | null;
  p1: boolean;
  fullCount: number;
  fullOnExpected: number;
  fullOnUnexpected: number;
}

function scoreQuery(query: EvalQuery, results: any[]): QueryScore {
  const expected = new Set(query.expect ?? []);
  const hitRanks: number[] = [];
  let fullCount = 0;
  let fullOnExpected = 0;
  let fullOnUnexpected = 0;
  const matchedExpectations = new Set<string>();

  results.forEach((r, i) => {
    const keys = keysFor(r);
    const matches = keys.filter((k) => expected.has(k));
    const isExpected = matches.length > 0;
    if (isExpected) {
      hitRanks.push(i + 1);
      // Credit the specific expectation(s) this result satisfies, so recall
      // counts distinct ground-truth items rather than result rows.
      matches.forEach((m) => matchedExpectations.add(m));
    }
    if (r.expansion === "full") {
      fullCount++;
      if (isExpected) fullOnExpected++;
      else fullOnUnexpected++;
    }
  });

  return {
    kind: query.kind,
    q: query.q,
    expected: expected.size,
    found: matchedExpectations.size,
    firstHitRank: hitRanks.length > 0 ? Math.min(...hitRanks) : null,
    p1: hitRanks.includes(1),
    fullCount,
    fullOnExpected,
    fullOnUnexpected
  };
}

function aggregate(scores: QueryScore[]) {
  // Negative queries have no ground truth; they are scored separately, on
  // whether the ranker resists expanding anything.
  const scored = scores.filter((s) => s.expected > 0);
  const negatives = scores.filter((s) => s.expected === 0);

  const n = scored.length || 1;
  const hits = scored.filter((s) => s.firstHitRank !== null);

  return {
    queries: scores.length,
    scored: scored.length,
    hit_at_10: hits.length / n,
    recall_at_10: scored.reduce((sum, s) => sum + s.found / s.expected, 0) / n,
    mrr: scored.reduce((sum, s) => sum + (s.firstHitRank ? 1 / s.firstHitRank : 0), 0) / n,
    p_at_1: scored.filter((s) => s.p1).length / n,
    // Of everything expanded to full content, how much was actually a right
    // answer? This is the token-budget question the tiering exists to answer.
    full_precision: (() => {
      const full = scored.reduce((sum, s) => sum + s.fullCount, 0);
      const good = scored.reduce((sum, s) => sum + s.fullOnExpected, 0);
      return full > 0 ? good / full : 0;
    })(),
    // Queries that found nothing right yet still expanded something to full:
    // confidently wrong context, the most expensive failure mode.
    false_confidence: scored.filter((s) => s.firstHitRank === null && s.fullCount > 0).length,
    negatives: {
      queries: negatives.length,
      // A query with no correct answer should expand nothing.
      expanded_full: negatives.filter((s) => s.fullCount > 0).length
    }
  };
}

function byKind(scores: QueryScore[]) {
  const kinds = [...new Set(scores.map((s) => s.kind))].sort();
  return Object.fromEntries(
    kinds.map((k) => {
      const subset = scores.filter((s) => s.kind === k);
      return [k, aggregate(subset)];
    })
  );
}

// ---------------------------------------------------------------- run

const dbPath = requireProbeDb();
const modelName = process.env.CODERECALL_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5";

const db = new MemoryDatabase(dbPath);
const embeddings = new EmbeddingManager(modelName);
await embeddings.init();
const search = new HybridSearch(db, embeddings);

const queries = loadQueries();
const scores: QueryScore[] = [];

for (const query of queries) {
  const results = await search.tieredSearch(query.q, "all", LIMIT, "selective");
  scores.push(scoreQuery(query, results));
}

const overall = aggregate(scores);
const perKind = byKind(scores);

// ---------------------------------------------------------------- report

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const num = (n: number) => n.toFixed(3);

console.log(`\n${"=".repeat(78)}`);
console.log(`eval: ${label}   model: ${modelName}`);
console.log(`corpus sha: ${corpusSha() ?? "(unpinned)"}   queries: ${overall.queries}`);
console.log("=".repeat(78));

console.log("\nper query kind");
console.log("  kind          n   hit@10  recall@10    MRR     P@1  full_prec");
for (const [kind, m] of Object.entries(perKind)) {
  if (m.scored === 0) continue;
  console.log(
    `  ${kind.padEnd(11)} ${String(m.scored).padStart(2)}   ` +
      `${pct(m.hit_at_10).padStart(6)}  ${pct(m.recall_at_10).padStart(9)}  ` +
      `${num(m.mrr).padStart(5)}  ${pct(m.p_at_1).padStart(6)}  ${pct(m.full_precision).padStart(9)}`
  );
}

console.log("\noverall");
console.log(`  hit@10            ${pct(overall.hit_at_10)}`);
console.log(`  recall@10         ${pct(overall.recall_at_10)}`);
console.log(`  MRR               ${num(overall.mrr)}`);
console.log(`  P@1               ${pct(overall.p_at_1)}`);
console.log(`  full precision    ${pct(overall.full_precision)}   (of full-expanded results, share that were correct)`);
console.log(
  `  false confidence  ${overall.false_confidence}/${overall.scored}   (found nothing right, still expanded to full)`
);
console.log(
  `  negatives         ${overall.negatives.expanded_full}/${overall.negatives.queries} expanded full   (should be 0)`
);

const misses = scores.filter((s) => s.expected > 0 && s.firstHitRank === null);
if (misses.length > 0) {
  console.log(`\ncomplete misses (${misses.length}) — nothing expected in top ${LIMIT}`);
  for (const m of misses) console.log(`  [${m.kind}] ${m.q}${m.fullCount > 0 ? `  (!! ${m.fullCount} full)` : ""}`);
}

// ---------------------------------------------------------------- baseline

const record = {
  label,
  model: modelName,
  corpus_sha: corpusSha(),
  limit: LIMIT,
  overall,
  per_kind: perKind,
  queries: scores
};

if (existsSync(BASELINE_PATH)) {
  const prev = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  const delta = (a: number, b: number) => {
    const d = a - b;
    return `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}pp`;
  };
  console.log(`\nvs baseline "${prev.label}" (${prev.model})`);
  console.log(`  hit@10     ${delta(overall.hit_at_10, prev.overall.hit_at_10)}`);
  console.log(`  recall@10  ${delta(overall.recall_at_10, prev.overall.recall_at_10)}`);
  console.log(
    `  MRR        ${(overall.mrr - prev.overall.mrr >= 0 ? "+" : "") + (overall.mrr - prev.overall.mrr).toFixed(3)}`
  );
  console.log(`  P@1        ${delta(overall.p_at_1, prev.overall.p_at_1)}`);
}

if (save) {
  writeFileSync(BASELINE_PATH, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nsaved baseline -> ${BASELINE_PATH}`);
} else {
  console.log(`\n(not saved — pass --save to write ${BASELINE_PATH})`);
}

db.close();
