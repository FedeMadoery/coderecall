/**
 * Score and tier distribution probe.
 *
 * Prints, per query, the top keyword score, top/median vector score, the final
 * blended score, and the full/summary/metadata split — the raw material for
 * calibrating tier thresholds. Produced Findings B–D in
 * docs/plan/IMPROVEMENT-PLAN.md.
 *
 * Corpus-agnostic: queries come from tests/eval/.local/queries.json (gitignored).
 * See tests/eval/README.md.
 */
import { MemoryDatabase } from "../../src/storage/database";
import { EmbeddingManager } from "../../src/embeddings/manager";
import { HybridSearch } from "../../src/search/hybrid";
import { loadQueries, requireProbeDb } from "./corpus";

const db = new MemoryDatabase(requireProbeDb());
const em = new EmbeddingManager(process.env.CODERECALL_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5");
await em.init();
const hs = new HybridSearch(db, em) as any;

const rows: any[] = [];
for (const { kind, q } of loadQueries()) {
  const kw = (await hs.keywordSearch(q, 50)) as Map<string, any>;
  const vec = (await hs.vectorSearch(q, 50)) as Map<string, any>;
  const tiered = await hs.tieredSearch(q, "all", 10, "selective");

  const kwv = [...kw.values()].map((v) => v.score);
  const vv = [...vec.values()].map((v) => v.score).sort((a, b) => b - a);
  const tallies: any = { full: 0, summary: 0, metadata: 0 };
  for (const r of tiered) tallies[r.expansion]++;

  rows.push({
    kind,
    q,
    top_kw: kwv.length ? Math.max(...kwv).toFixed(3) : "-",
    top_vec: vv.length ? vv[0]!.toFixed(3) : "-",
    med_vec: vv.length ? vv[Math.floor(vv.length / 2)]!.toFixed(3) : "-",
    top_final: tiered.length ? tiered[0].score.toFixed(3) : "-",
    tiers: `${tallies.full}/${tallies.summary}/${tallies.metadata}`,
    types: `${tiered.filter((r: any) => r.type === "code").length}c/${tiered.filter((r: any) => r.type === "knowledge").length}k`
  });
}

console.log("\n" + "=".repeat(110));
console.log("kind        top_kw top_vec med_vec top_final  F/S/M     c/k     query");
console.log("=".repeat(110));
for (const r of rows) {
  console.log(
    `${r.kind.padEnd(11)} ${r.top_kw.padStart(6)} ${r.top_vec.padStart(7)} ${r.med_vec.padStart(7)} ` +
      `${r.top_final.padStart(9)}  ${r.tiers.padEnd(9)} ${r.types.padEnd(7)} ${r.q}`
  );
}
console.log("=".repeat(110));

const finals = rows.map((r) => parseFloat(r.top_final)).filter((n) => !isNaN(n));
const kws = rows.map((r) => parseFloat(r.top_kw)).filter((n) => !isNaN(n));
console.log(
  `top-result finalScore: min=${Math.min(...finals).toFixed(3)} ` +
    `max=${Math.max(...finals).toFixed(3)} ` +
    `mean=${(finals.reduce((a, b) => a + b, 0) / finals.length).toFixed(3)}`
);
console.log(`queries where top_kw saturated at 1.000: ${kws.filter((n) => n >= 0.999).length}/${kws.length}`);
console.log(`thresholds in effect: full >= 0.7, summary >= 0.4`);

db.close();
