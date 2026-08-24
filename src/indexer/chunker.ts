import { MemoryDatabase } from "../storage/database";
import { EmbeddingManager } from "../embeddings/manager";
import { getParserForFile } from "./parsers";
import { FileScanner, type ScannedFile, type FileScannerOptions } from "./scanner";
import type { CodeChunk, IndexFilesResult, IndexDiffResult } from "../types";

export interface IndexFilesOptions {
  /**
   * Drop index entries for files that were not part of this scan.
   *
   * Only safe when `files` is a COMPLETE scan of the project root: pruning
   * compares the scan against the whole index, so a partial scan would delete
   * everything it didn't happen to cover. Callers are responsible for that
   * guarantee — see the project-root check in the CLI and MCP `index_files`.
   */
  prune?: boolean;
}

export class CodeChunker {
  private db: MemoryDatabase;
  private embeddings: EmbeddingManager;

  constructor(db: MemoryDatabase, embeddings: EmbeddingManager) {
    this.db = db;
    this.embeddings = embeddings;
  }

  async indexFiles(files: ScannedFile[], options: IndexFilesOptions = {}): Promise<IndexFilesResult> {
    const startTime = Date.now();
    let filesIndexed = 0;
    let chunksCreated = 0;

    for (const file of files) {
      try {
        const result = await this.indexFile(file);
        filesIndexed++;
        chunksCreated += result;
      } catch (err) {
        console.error(`Failed to index ${file.relativePath}:`, err);
      }
    }

    const prunedPaths = options.prune ? this.pruneMissingFiles(files) : [];

    this.db.markIndexRun();

    return {
      files_indexed: filesIndexed,
      chunks_created: chunksCreated,
      time_ms: Date.now() - startTime,
      files_pruned: prunedPaths.length,
      pruned_paths: prunedPaths
    };
  }

  /**
   * Remove index entries whose files were not seen in this scan — i.e. deleted,
   * renamed, or newly excluded (gitignored, or dropped from `extensions`).
   *
   * A full `index` run is content-hash-aware and skips unchanged files, but it
   * had no way to notice a file that simply stopped existing, so stale chunks
   * kept scoring in every search. Measured on a real project: 31 phantom files
   * carrying 274 chunks, surfacing in 16% of code results — some at full
   * expansion, handing the agent the contents of a deleted file.
   */
  private pruneMissingFiles(files: ScannedFile[]): string[] {
    // An empty scan is far more likely a misconfiguration (wrong --extensions,
    // wrong cwd, ignore glob swallowing the tree) than a project where every
    // file was deleted. Refuse to wipe the index on that signal.
    if (files.length === 0) {
      console.error("Skipping prune: the scan matched no files, which would empty the index.");
      return [];
    }

    const scanned = new Set(files.map((f) => f.relativePath));
    const pruned: string[] = [];

    for (const filepath of this.db.listCodeFilepaths()) {
      if (scanned.has(filepath)) continue;
      if (this.db.deleteCodeFile(filepath)) pruned.push(filepath);
    }

    return pruned;
  }

  async indexFile(file: ScannedFile): Promise<number> {
    const contentHash = MemoryDatabase.hashContent(file.content);

    const existingFile = this.db.getCodeFile(file.relativePath);
    if (existingFile && existingFile.content_hash === contentHash) {
      return 0;
    }

    const codeFile = this.db.upsertCodeFile(file.relativePath, file.language, contentHash);

    if (existingFile) {
      this.db.deleteChunksForFile(existingFile.id);
    }

    const parser = getParserForFile(file.relativePath);
    let parsedChunks = parser.parse(file.content);

    if (parsedChunks.length === 0) {
      parsedChunks = [
        {
          chunk_type: "block",
          visibility: null,
          name: file.relativePath,
          content: file.content,
          start_line: 1,
          end_line: file.content.split("\n").length,
          parent_name: null,
          signature: null,
          docstring: null
        }
      ];
    }

    const parentIdMap = new Map<string, string>();
    const createdChunks: CodeChunk[] = [];

    for (const parsed of parsedChunks) {
      let parentId: string | null = null;
      if (parsed.parent_name && parentIdMap.has(parsed.parent_name)) {
        parentId = parentIdMap.get(parsed.parent_name)!;
      }

      const chunk = this.db.addCodeChunk({
        file_id: codeFile.id,
        chunk_type: parsed.chunk_type,
        visibility: parsed.visibility,
        name: parsed.name,
        content: parsed.content,
        start_line: parsed.start_line,
        end_line: parsed.end_line,
        parent_id: parentId,
        signature: parsed.signature,
        docstring: parsed.docstring
      });

      createdChunks.push(chunk);

      if (parsed.chunk_type === "module" || parsed.chunk_type === "class") {
        parentIdMap.set(parsed.name, chunk.id);
      }
    }

    await this.embedChunks(createdChunks);

    return createdChunks.length;
  }

  private async embedChunks(chunks: CodeChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const texts = chunks.map((chunk) => {
      const parts = [chunk.name];
      if (chunk.signature) parts.push(chunk.signature);
      if (chunk.docstring) parts.push(chunk.docstring);
      parts.push(chunk.content);
      return parts.join("\n").slice(0, 8000);
    });

    let vectors: Float32Array[];
    try {
      vectors = await this.embeddings.embedBatch(texts);
    } catch (err) {
      console.error(`Failed to embed batch of ${chunks.length} chunks:`, err);
      return;
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vector = vectors[i];
      if (!vector) continue;
      this.db.saveEmbedding("code", chunk.id, vector);
      this.db.indexForFTS(
        chunk.id,
        "code",
        chunk.name,
        `${chunk.signature || ""} ${chunk.docstring || ""} ${chunk.content}`.slice(0, 10000)
      );
    }
  }

  async indexDiff(
    basePath: string,
    baseRef: string,
    headRef: string,
    scannerOptions: FileScannerOptions = {}
  ): Promise<IndexDiffResult> {
    const startTime = Date.now();
    const scanner = new FileScanner(basePath, scannerOptions);

    const { added, modified, deleted } = scanner.getChangedFiles(baseRef, headRef);

    for (const filepath of deleted) {
      this.db.deleteCodeFile(filepath);
    }

    const filesToIndex = [...added, ...modified];
    const scannedFiles = await scanner.scanFiles(filesToIndex);

    for (const file of scannedFiles) {
      await this.indexFile(file);
    }

    this.db.markIndexRun();

    return {
      added: added.length,
      modified: modified.length,
      deleted: deleted.length,
      time_ms: Date.now() - startTime
    };
  }
}
