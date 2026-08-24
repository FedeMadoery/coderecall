import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { MemoryDatabase } from "../src/storage/database";
import { CodeChunker } from "../src/indexer/chunker";
import { FileScanner } from "../src/indexer/scanner";
import type { EmbeddingManager } from "../src/embeddings/manager";

/**
 * Deterministic stand-in for the real embedder: the pruning logic doesn't care
 * about vector values, and loading a 30 MB ONNX model per test does not earn
 * its runtime.
 */
const fakeEmbeddings = {
  init: async () => {},
  embed: async () => new Float32Array(384).fill(0.1),
  embedQuery: async () => new Float32Array(384).fill(0.1),
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.1)),
  getModelName: () => "test/fake-embedder",
  getDimension: () => 384,
  getQueryPrefix: () => ""
} as unknown as EmbeddingManager;

let root: string;
let db: MemoryDatabase;
let chunker: CodeChunker;

function scanner(base: string = root) {
  // Temp dirs are not git repos; force the glob path so the scan is predictable.
  return new FileScanner(base, { extensions: [".ts"], useGit: false });
}

async function indexAll(opts: { prune?: boolean } = {}) {
  const files = await scanner().scanAll();
  return chunker.indexFiles(files, opts);
}

/** Raw row counts, to prove FTS and embeddings are cleaned up too. */
function rowCounts() {
  const raw = (db as any).db;
  return {
    files: raw.prepare("SELECT count(*) c FROM code_files").get().c,
    chunks: raw.prepare("SELECT count(*) c FROM code_chunks").get().c,
    embeddings: raw.prepare("SELECT count(*) c FROM embeddings").get().c,
    fts: raw.prepare("SELECT count(*) c FROM memory_fts").get().c
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "coderecall-prune-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "alpha.ts"), "export function alpha() { return 'a'; }\n");
  writeFileSync(join(root, "src", "beta.ts"), "export function beta() { return 'b'; }\n");
  writeFileSync(join(root, "src", "gamma.ts"), "export function gamma() { return 'c'; }\n");

  mkdirSync(join(root, ".coderecall"), { recursive: true });
  db = new MemoryDatabase(join(root, ".coderecall", "index.db"));
  chunker = new CodeChunker(db, fakeEmbeddings);

  await indexAll({ prune: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("prune on full index", () => {
  test("indexes the initial tree with nothing to prune", () => {
    expect(db.listCodeFilepaths().sort()).toEqual(["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]);
    expect(rowCounts().files).toBe(3);
  });

  test("drops a deleted file, including its chunks, embeddings and FTS rows", async () => {
    const before = rowCounts();

    unlinkSync(join(root, "src", "beta.ts"));
    const result = await indexAll({ prune: true });

    expect(result.files_pruned).toBe(1);
    expect(result.pruned_paths).toEqual(["src/beta.ts"]);
    expect(db.listCodeFilepaths().sort()).toEqual(["src/alpha.ts", "src/gamma.ts"]);

    const after = rowCounts();
    expect(after.files).toBe(2);
    expect(after.chunks).toBeLessThan(before.chunks);
    // The pollution being fixed: dead vectors and FTS rows must go too, or the
    // chunk keeps scoring in every search.
    expect(after.embeddings).toBe(after.chunks);
    expect(after.fts).toBe(after.chunks);
  });

  test("a rename leaves only the new path behind", async () => {
    renameSync(join(root, "src", "alpha.ts"), join(root, "src", "renamed.ts"));
    const result = await indexAll({ prune: true });

    expect(result.pruned_paths).toEqual(["src/alpha.ts"]);
    expect(db.listCodeFilepaths().sort()).toEqual(["src/beta.ts", "src/gamma.ts", "src/renamed.ts"]);
  });

  test("a deleted file survives when pruning is off", async () => {
    unlinkSync(join(root, "src", "beta.ts"));
    const result = await indexAll({ prune: false });

    expect(result.files_pruned).toBe(0);
    // This is the pre-fix behaviour, kept explicit so --no-prune stays honest.
    expect(db.listCodeFilepaths()).toContain("src/beta.ts");
  });

  test("pruned chunks stop coming back from the vector cache", async () => {
    // Warm the in-process cache the way a running MCP server would, then prune.
    db.warmEmbeddingsCache();
    const warmed = db.getAllEmbeddings().length;

    unlinkSync(join(root, "src", "beta.ts"));
    await indexAll({ prune: true });

    expect(db.getAllEmbeddings().length).toBeLessThan(warmed);
    expect(db.getAllEmbeddings().length).toBe(rowCounts().embeddings);
  });
});

describe("prune safety rails", () => {
  test("an empty scan never empties the index", async () => {
    const result = await chunker.indexFiles([], { prune: true });

    expect(result.files_pruned).toBe(0);
    expect(db.listCodeFilepaths().length).toBe(3);
  });

  test("a partial scan with prune would delete the rest — callers must gate it", async () => {
    // Documents why prune is gated on scan-root == project-root in the CLI and
    // MCP layers: the chunker cannot tell a scoped scan from a shrunken project.
    const partial = await scanner(join(root, "src")).scanAll();
    const onlyAlpha = partial.filter((f) => f.relativePath.endsWith("alpha.ts"));

    const result = await chunker.indexFiles(onlyAlpha, { prune: true });

    expect(result.files_pruned).toBe(3);
  });
});
