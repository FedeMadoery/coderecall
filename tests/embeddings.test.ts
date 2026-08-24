import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { MemoryDatabase } from "../src/storage/database";
import { EmbeddingManager, queryPrefixFor } from "../src/embeddings/manager";

const BGE = "Xenova/bge-small-en-v1.5";
const JINA = "jinaai/jina-embeddings-v2-base-code";

describe("query prefix registry", () => {
  const saved = process.env.CODERECALL_QUERY_PREFIX;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODERECALL_QUERY_PREFIX;
    else process.env.CODERECALL_QUERY_PREFIX = saved;
  });

  test("asymmetric models get their documented instruction prefix", () => {
    delete process.env.CODERECALL_QUERY_PREFIX;
    expect(queryPrefixFor(BGE)).toBe("Represent this sentence for searching relevant passages: ");
    expect(queryPrefixFor("Snowflake/snowflake-arctic-embed-s")).toBe(
      "Represent this sentence for searching relevant passages: "
    );
  });

  test("symmetric models get none", () => {
    delete process.env.CODERECALL_QUERY_PREFIX;
    expect(queryPrefixFor(JINA)).toBe("");
  });

  test("unknown models default to none — a wrong prefix is worse than no prefix", () => {
    delete process.env.CODERECALL_QUERY_PREFIX;
    expect(queryPrefixFor("some-org/some-unreleased-model")).toBe("");
  });

  test("env override wins, including an empty string to disable", () => {
    process.env.CODERECALL_QUERY_PREFIX = "custom: ";
    expect(queryPrefixFor(BGE)).toBe("custom: ");
    process.env.CODERECALL_QUERY_PREFIX = "";
    expect(queryPrefixFor(BGE)).toBe("");
  });

  test("the manager exposes the prefix it resolved", () => {
    delete process.env.CODERECALL_QUERY_PREFIX;
    expect(new EmbeddingManager(BGE).getQueryPrefix()).toContain("Represent this sentence");
    expect(new EmbeddingManager(JINA).getQueryPrefix()).toBe("");
  });
});

describe("dimension is learned, not assumed", () => {
  test("getDimension throws before init rather than reporting a guess", () => {
    // The old code hardcoded 384, which is how a 768-D swap could go unnoticed.
    expect(() => new EmbeddingManager(JINA).getDimension()).toThrow(/call init/i);
  });
});

describe("embedding compatibility check", () => {
  let root: string;
  let db: MemoryDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coderecall-embed-"));
    db = new MemoryDatabase(join(root, "index.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("an empty index is compatible with anything", () => {
    expect(db.checkEmbeddingCompatibility(JINA, 768).ok).toBe(true);
  });

  test("saving an embedding stamps the model and width", () => {
    db.saveEmbedding("code", "chunk_1", new Float32Array(384).fill(0.1), BGE);
    expect(db.getEmbeddingModelMeta()).toEqual({ model: BGE, dim: 384 });
  });

  test("a width mismatch is reported, not left to fail silently at query time", () => {
    db.saveEmbedding("code", "chunk_1", new Float32Array(384).fill(0.1), BGE);

    const result = db.checkEmbeddingCompatibility(JINA, 768);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("384-D");
    expect(result.reason).toContain("768-D");
  });

  test("a same-width model swap is reported too — comparable shape, different meaning", () => {
    db.saveEmbedding("code", "chunk_1", new Float32Array(384).fill(0.1), BGE);

    const result = db.checkEmbeddingCompatibility("Snowflake/snowflake-arctic-embed-s", 384);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("reindex");
  });

  test("the model it was built with stays compatible", () => {
    db.saveEmbedding("code", "chunk_1", new Float32Array(384).fill(0.1), BGE);
    expect(db.checkEmbeddingCompatibility(BGE, 384).ok).toBe(true);
  });

  test("re-stamping after a real reindex clears the mismatch", () => {
    db.saveEmbedding("code", "chunk_1", new Float32Array(384).fill(0.1), BGE);
    expect(db.checkEmbeddingCompatibility(JINA, 768).ok).toBe(false);

    // What a reindex does: drop the old vectors, write new ones.
    (db as any).db.prepare("DELETE FROM embeddings").run();
    db.saveEmbedding("code", "chunk_1", new Float32Array(768).fill(0.1), JINA);

    expect(db.checkEmbeddingCompatibility(JINA, 768).ok).toBe(true);
    expect(db.getEmbeddingModelMeta()).toEqual({ model: JINA, dim: 768 });
  });
});
