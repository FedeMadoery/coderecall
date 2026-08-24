/**
 * Phantom-pollution probe.
 *
 * Measures how many search results point at files that no longer exist in the
 * corpus working tree. Produced Finding A in docs/plan/IMPROVEMENT-PLAN.md
 * (16% of code results before pruning), and is the exit criterion for the
 * pruning work (0%).
 *
 * Corpus-agnostic: reads tests/eval/.local/{queries.json,phantoms.txt}.
 */
import { MemoryDatabase } from "../../src/storage/database";
import { EmbeddingManager } from "../../src/embeddings/manager";
import { HybridSearch } from "../../src/search/hybrid";
import { loadQueries, loadPhantoms, requireProbeDb } from "./corpus";

const phantoms = loadPhantoms();
const db = new MemoryDatabase(requireProbeDb());
const em = new EmbeddingManager(process.env.CODERECALL_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5");
await em.init();
const hs = new HybridSearch(db, em) as any;

let totalCode = 0;
let totalPhantom = 0;
let queriesHit = 0;
const detail: string[] = [];

for (const { q } of loadQueries()) {
  const tiered = await hs.tieredSearch(q, "all", 10, "selective");
  const code = tiered.filter((r: any) => r.type === "code");
  const dead = code.filter((r: any) => phantoms.has(r.filepath));

  totalCode += code.length;
  totalPhantom += dead.length;
  if (dead.length > 0) {
    queriesHit++;
    detail.push(
      `  ${String(dead.length).padStart(2)}/${String(code.length).padStart(2)} dead  "${q}"` +
        `  e.g. ${dead[0].filepath} [${dead[0].expansion}]`
    );
  }
}

const queryCount = loadQueries().length;
console.log("\n=== phantom pollution in search results ===");
console.log(detail.length > 0 ? detail.join("\n") : "  (none)");
console.log(`\nqueries returning >=1 deleted file : ${queriesHit}/${queryCount}`);
console.log(
  `code results pointing at deleted files: ${totalPhantom}/${totalCode}` +
    ` (${totalCode > 0 ? ((totalPhantom / totalCode) * 100).toFixed(1) : "0.0"}%)`
);

db.close();
