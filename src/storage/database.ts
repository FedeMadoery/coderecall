import { Database } from "bun:sqlite";
import { SCHEMA } from "./schema";
import type { KnowledgeEntry, CodeFile, CodeChunk, IndexStats, IndexFreshness, IndexFreshnessStatus } from "../types";
import { createHash, randomUUID } from "crypto";

type CachedEmbedding = { source_type: "code" | "knowledge"; source_id: string; vector: Float32Array };

export class MemoryDatabase {
  public db: Database;

  // In-memory mirror of the embeddings table. Populated lazily on first
  // getAllEmbeddings() call (or eagerly via warmEmbeddingsCache()) and kept
  // in sync by saveEmbedding / delete* below. This is the hot path —
  // vectorSearch hits this on every query, so we serve it from RAM instead
  // of re-reading every blob from SQLite.
  private embeddingsCache: CachedEmbedding[] | null = null;
  private embeddingsIndex: Map<string, number> = new Map();
  private recordedEmbeddingStamp: string | null = null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.init();
  }

  private init() {
    this.db.exec(SCHEMA);
  }

  // ==================== Knowledge Operations ====================

  addKnowledge(entry: Omit<KnowledgeEntry, "id" | "created_at" | "updated_at">): KnowledgeEntry {
    const id = `knowledge_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO knowledge_entries (id, title, content, category, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, entry.title, entry.content, entry.category, JSON.stringify(entry.tags), now, now);

    return {
      id,
      ...entry,
      created_at: now,
      updated_at: now
    };
  }

  getKnowledge(id: string): KnowledgeEntry | null {
    const row = this.db.prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      ...row,
      tags: JSON.parse(row.tags || "[]")
    };
  }

  /**
   * Look up a knowledge entry by exact title.
   *
   * Importers use this to replace an entry on re-import. They previously called
   * listKnowledge() per file and scanned the result, which loaded and
   * JSON-parsed every entry once per imported file.
   */
  getKnowledgeByTitle(title: string): KnowledgeEntry | null {
    const row = this.db.prepare("SELECT * FROM knowledge_entries WHERE title = ? LIMIT 1").get(title) as any;
    if (!row) return null;
    return { ...row, tags: JSON.parse(row.tags || "[]") };
  }

  listKnowledge(category?: string, tag?: string): KnowledgeEntry[] {
    let query = "SELECT * FROM knowledge_entries WHERE 1=1";
    const params: any[] = [];

    if (category) {
      query += " AND category = ?";
      params.push(category);
    }

    if (tag) {
      query += " AND tags LIKE ?";
      params.push(`%"${tag}"%`);
    }

    query += " ORDER BY created_at DESC";

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => ({
      ...row,
      tags: JSON.parse(row.tags || "[]")
    }));
  }

  deleteKnowledge(id: string): boolean {
    const result = this.db.prepare("DELETE FROM knowledge_entries WHERE id = ?").run(id);
    // Also delete from FTS and embeddings
    this.db.prepare("DELETE FROM memory_fts WHERE source_id = ?").run(id);
    this.db.prepare("DELETE FROM embeddings WHERE source_id = ?").run(id);
    this.cacheRemove(id);
    return result.changes > 0;
  }

  // ==================== Code File Operations ====================

  upsertCodeFile(filepath: string, language: string, contentHash: string): CodeFile {
    const existing = this.db.prepare("SELECT * FROM code_files WHERE filepath = ?").get(filepath) as any;

    if (existing) {
      // Update existing file
      this.db
        .prepare(
          `
        UPDATE code_files SET content_hash = ?, indexed_at = datetime('now') WHERE id = ?
      `
        )
        .run(contentHash, existing.id);
      return { ...existing, content_hash: contentHash };
    }

    // Insert new file
    const id = `file_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
      INSERT INTO code_files (id, filepath, language, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(id, filepath, language, contentHash, now);

    return { id, filepath, language, content_hash: contentHash, indexed_at: now };
  }

  getCodeFile(filepath: string): CodeFile | null {
    return this.db.prepare("SELECT * FROM code_files WHERE filepath = ?").get(filepath) as CodeFile | null;
  }

  /** Every filepath currently in the index. Used to prune files deleted on disk. */
  listCodeFilepaths(): string[] {
    const rows = this.db.prepare("SELECT filepath FROM code_files").all() as Array<{ filepath: string }>;
    return rows.map((r) => r.filepath);
  }

  /** Chunk id -> chunk name, for the ids given. Used by definition-intent boosting. */
  getChunkNames(ids: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    // Chunked IN clause: pools can exceed SQLite's variable limit on large limits.
    const BATCH = 500;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const placeholders = slice.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT id, name FROM code_chunks WHERE id IN (${placeholders})`)
        .all(...slice) as Array<{ id: string; name: string }>;
      for (const row of rows) out.set(row.id, row.name);
    }
    return out;
  }

  getCodeFileById(id: string): CodeFile | null {
    return this.db.prepare("SELECT * FROM code_files WHERE id = ?").get(id) as CodeFile | null;
  }

  deleteCodeFile(filepath: string): boolean {
    const file = this.getCodeFile(filepath);
    if (!file) return false;

    // Cascading delete handles chunks, but we need to clean FTS and embeddings
    const chunks = this.db.prepare("SELECT id FROM code_chunks WHERE file_id = ?").all(file.id) as any[];
    for (const chunk of chunks) {
      this.db.prepare("DELETE FROM memory_fts WHERE source_id = ?").run(chunk.id);
      this.db.prepare("DELETE FROM embeddings WHERE source_id = ?").run(chunk.id);
      this.cacheRemove(chunk.id);
    }

    const result = this.db.prepare("DELETE FROM code_files WHERE filepath = ?").run(filepath);
    return result.changes > 0;
  }

  // ==================== Code Chunk Operations ====================

  addCodeChunk(chunk: Omit<CodeChunk, "id">): CodeChunk {
    const id = `chunk_${Date.now()}_${randomUUID().slice(0, 8)}`;

    this.db
      .prepare(
        `
      INSERT INTO code_chunks (id, file_id, chunk_type, visibility, name, content, start_line, end_line, parent_id, signature, docstring)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        chunk.file_id,
        chunk.chunk_type,
        chunk.visibility,
        chunk.name,
        chunk.content,
        chunk.start_line,
        chunk.end_line,
        chunk.parent_id,
        chunk.signature,
        chunk.docstring
      );

    return { id, ...chunk };
  }

  getChunksForFile(fileId: string): CodeChunk[] {
    return this.db.prepare("SELECT * FROM code_chunks WHERE file_id = ?").all(fileId) as CodeChunk[];
  }

  deleteChunksForFile(fileId: string): number {
    // First clean up FTS and embeddings
    const chunks = this.db.prepare("SELECT id FROM code_chunks WHERE file_id = ?").all(fileId) as any[];
    for (const chunk of chunks) {
      this.db.prepare("DELETE FROM memory_fts WHERE source_id = ?").run(chunk.id);
      this.db.prepare("DELETE FROM embeddings WHERE source_id = ?").run(chunk.id);
      this.cacheRemove(chunk.id);
    }

    const result = this.db.prepare("DELETE FROM code_chunks WHERE file_id = ?").run(fileId);
    return result.changes;
  }

  // ==================== Embedding Operations ====================

  saveEmbedding(sourceType: "code" | "knowledge", sourceId: string, vector: Float32Array, model: string) {
    // Stamp which model actually produced the vectors in this index. Without
    // this, a model or dimension swap is undetectable: cosineSimilarity throws
    // on a width mismatch, vectorSearch swallows it, and search silently
    // degrades to keyword-only.
    this.recordEmbeddingModel(model, vector.length);

    const id = `emb_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const vectorBuffer = Buffer.from(vector.buffer);

    // Delete existing embedding for this source
    this.db.prepare("DELETE FROM embeddings WHERE source_id = ?").run(sourceId);

    this.db
      .prepare(
        `
      INSERT INTO embeddings (id, source_type, source_id, vector, model)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(id, sourceType, sourceId, vectorBuffer, model);

    this.cacheUpsert(sourceType, sourceId, vector);
  }

  /** Remember the model + width behind this index. Cheap: writes only on change. */
  private recordEmbeddingModel(model: string, dim: number) {
    const stamp = `${model}:${dim}`;
    if (this.recordedEmbeddingStamp === stamp) return;
    this.setMeta("embedding_model", model);
    this.setMeta("embedding_dim", String(dim));
    this.recordedEmbeddingStamp = stamp;
  }

  /** The model + width this index was built with, if it has ever been stamped. */
  getEmbeddingModelMeta(): { model: string | null; dim: number | null } {
    const model = this.getMeta("embedding_model");
    const rawDim = this.getMeta("embedding_dim");
    return { model, dim: rawDim ? Number(rawDim) : null };
  }

  /**
   * Is this index usable with the given model?
   *
   * A width mismatch is fatal for vector search but invisible at runtime, so it
   * is worth an explicit up-front check. An empty index is always compatible.
   * A same-width model change is reported too: the vectors are comparable in
   * shape but not in meaning, so results would quietly get worse.
   */
  checkEmbeddingCompatibility(model: string, dim: number): { ok: boolean; reason?: string } {
    const stored = this.db.prepare("SELECT vector FROM embeddings LIMIT 1").get() as any;
    if (!stored) return { ok: true };

    const storedDim = (stored.vector?.length ?? 0) / 4;
    const meta = this.getEmbeddingModelMeta();

    if (storedDim && storedDim !== dim) {
      return {
        ok: false,
        reason:
          `Index holds ${storedDim}-D vectors but ${model} produces ${dim}-D. ` +
          `Vector search would fail silently. Delete the index and reindex.`
      };
    }
    if (meta.model && meta.model !== model) {
      return {
        ok: false,
        reason:
          `Index was built with ${meta.model}, now configured for ${model}. ` +
          `Same width, different meaning — reindex for correct results.`
      };
    }
    return { ok: true };
  }

  getEmbedding(sourceId: string): Float32Array | null {
    const row = this.db.prepare("SELECT vector FROM embeddings WHERE source_id = ?").get(sourceId) as any;
    if (!row) return null;

    // Handle Bun's SQLite blob format
    const blob = row.vector;
    if (blob instanceof Buffer) {
      return new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);
    }
    if (blob instanceof Uint8Array) {
      return new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);
    }
    return null;
  }

  getAllEmbeddings(): Array<{ source_type: string; source_id: string; vector: Float32Array }> {
    this.populateEmbeddingsCache();
    return this.embeddingsCache!;
  }

  /**
   * Eagerly populate the embeddings cache. Call this at server startup
   * (after the embeddings model is initialized) so the first vector search
   * doesn't pay the load cost. For an empty DB this is a no-op.
   */
  warmEmbeddingsCache(): { loaded: number; bytes: number } {
    this.populateEmbeddingsCache();
    const cache = this.embeddingsCache!;
    const bytes = cache.reduce((sum, e) => sum + e.vector.byteLength, 0);
    return { loaded: cache.length, bytes };
  }

  private populateEmbeddingsCache() {
    if (this.embeddingsCache !== null) return;
    const rows = this.db.prepare("SELECT source_type, source_id, vector FROM embeddings").all() as any[];

    const cache: CachedEmbedding[] = [];
    const index = new Map<string, number>();

    for (const row of rows) {
      const vector = blobToVector(row.vector);
      index.set(row.source_id, cache.length);
      cache.push({
        source_type: row.source_type,
        source_id: row.source_id,
        vector
      });
    }

    this.embeddingsCache = cache;
    this.embeddingsIndex = index;
  }

  private cacheUpsert(sourceType: "code" | "knowledge", sourceId: string, vector: Float32Array) {
    if (this.embeddingsCache === null) return; // not warmed yet — next getAllEmbeddings will load fresh
    const existingIdx = this.embeddingsIndex.get(sourceId);
    if (existingIdx !== undefined) {
      this.embeddingsCache[existingIdx] = { source_type: sourceType, source_id: sourceId, vector };
    } else {
      this.embeddingsIndex.set(sourceId, this.embeddingsCache.length);
      this.embeddingsCache.push({ source_type: sourceType, source_id: sourceId, vector });
    }
  }

  private cacheRemove(sourceId: string) {
    if (this.embeddingsCache === null) return;
    const idx = this.embeddingsIndex.get(sourceId);
    if (idx === undefined) return;
    const last = this.embeddingsCache.length - 1;
    if (idx !== last) {
      // Swap-with-last so we can pop() in O(1)
      const moved = this.embeddingsCache[last]!;
      this.embeddingsCache[idx] = moved;
      this.embeddingsIndex.set(moved.source_id, idx);
    }
    this.embeddingsCache.pop();
    this.embeddingsIndex.delete(sourceId);
  }

  private _legacyGetAllEmbeddings(): Array<{ source_type: string; source_id: string; vector: Float32Array }> {
    // Kept around as a fallback / for debugging — bypasses the cache.
    const rows = this.db.prepare("SELECT source_type, source_id, vector FROM embeddings").all() as any[];
    return rows.map((row) => {
      const vector = blobToVector(row.vector);
      return {
        source_type: row.source_type,
        source_id: row.source_id,
        vector
      };
    });
  }

  // ==================== FTS Operations ====================

  indexForFTS(sourceId: string, sourceType: "code" | "knowledge", name: string, content: string) {
    // Delete existing FTS entry
    this.db.prepare("DELETE FROM memory_fts WHERE source_id = ?").run(sourceId);

    this.db
      .prepare(
        `
      INSERT INTO memory_fts (source_id, source_type, name, content)
      VALUES (?, ?, ?, ?)
    `
      )
      .run(sourceId, sourceType, name, content);
  }

  searchFTS(query: string, limit: number = 20): Array<{ source_id: string; source_type: string; rank: number }> {
    const rows = this.db
      .prepare(
        `
      SELECT source_id, source_type, rank
      FROM memory_fts
      WHERE memory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `
      )
      .all(query, limit) as any[];
    return rows;
  }

  // ==================== Stats ====================

  getStats(): IndexStats {
    const files = this.db.prepare("SELECT COUNT(*) as count FROM code_files").get() as any;
    const chunks = this.db.prepare("SELECT COUNT(*) as count FROM code_chunks").get() as any;
    const knowledge = this.db.prepare("SELECT COUNT(*) as count FROM knowledge_entries").get() as any;
    const embeddings = this.db.prepare("SELECT COUNT(*) as count FROM embeddings").get() as any;
    const lastIndexed = this.db.prepare("SELECT MAX(indexed_at) as last FROM code_files").get() as any;

    return {
      total_files: files.count,
      total_chunks: chunks.count,
      total_knowledge: knowledge.count,
      total_embeddings: embeddings.count,
      last_indexed: lastIndexed.last
    };
  }

  // ==================== Meta / freshness ====================

  setMeta(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO meta (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  markIndexRun() {
    this.setMeta("last_index_run", new Date().toISOString());
  }

  /**
   * Compute how stale the index is. Prefers the explicit `meta.last_index_run`
   * timestamp (set at the end of every full/diff index pass) and falls back to
   * MAX(code_files.indexed_at) for databases created before that meta key existed.
   */
  getIndexAge(staleAfterDays: number, veryStaleAfterDays: number): IndexFreshness {
    let lastIndexRun = this.getMeta("last_index_run");

    if (!lastIndexRun) {
      const row = this.db.prepare("SELECT MAX(indexed_at) AS last FROM code_files").get() as
        | { last: string | null }
        | undefined;
      lastIndexRun = row?.last ?? null;
    }

    if (!lastIndexRun) {
      return {
        lastIndexRun: null,
        daysOld: null,
        status: "unknown",
        staleAfterDays,
        veryStaleAfterDays
      };
    }

    const parsed = Date.parse(lastIndexRun.replace(" ", "T")); // tolerate "YYYY-MM-DD HH:MM:SS"
    if (Number.isNaN(parsed)) {
      return {
        lastIndexRun,
        daysOld: null,
        status: "unknown",
        staleAfterDays,
        veryStaleAfterDays
      };
    }

    const daysOld = (Date.now() - parsed) / (1000 * 60 * 60 * 24);
    let status: IndexFreshnessStatus = "fresh";
    if (daysOld >= veryStaleAfterDays) status = "very_stale";
    else if (daysOld >= staleAfterDays) status = "stale";

    return {
      lastIndexRun,
      daysOld: Math.floor(daysOld),
      status,
      staleAfterDays,
      veryStaleAfterDays
    };
  }

  // ==================== Utilities ====================

  static hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  close() {
    this.db.close();
  }

  // Transaction helper
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function blobToVector(blob: unknown): Float32Array {
  if (blob instanceof Buffer) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);
  }
  if (blob instanceof Uint8Array) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.length / 4);
  }
  return new Float32Array(0);
}
