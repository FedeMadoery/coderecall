import { MemoryDatabase } from "../storage/database";
import { EmbeddingManager } from "../embeddings/manager";
import { getParserForFile } from "./parsers";
import { FileScanner, type ScannedFile, type FileScannerOptions } from "./scanner";
import type { CodeChunk, IndexFilesResult, IndexDiffResult } from "../types";

export class CodeChunker {
  private db: MemoryDatabase;
  private embeddings: EmbeddingManager;

  constructor(db: MemoryDatabase, embeddings: EmbeddingManager) {
    this.db = db;
    this.embeddings = embeddings;
  }

  async indexFiles(files: ScannedFile[]): Promise<IndexFilesResult> {
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

    this.db.markIndexRun();

    return {
      files_indexed: filesIndexed,
      chunks_created: chunksCreated,
      time_ms: Date.now() - startTime
    };
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
    for (const chunk of chunks) {
      const textParts = [chunk.name];
      if (chunk.signature) textParts.push(chunk.signature);
      if (chunk.docstring) textParts.push(chunk.docstring);
      textParts.push(chunk.content);

      const text = textParts.join("\n").slice(0, 8000);

      try {
        const vector = await this.embeddings.embed(text);
        this.db.saveEmbedding("code", chunk.id, vector);
        this.db.indexForFTS(
          chunk.id,
          "code",
          chunk.name,
          `${chunk.signature || ""} ${chunk.docstring || ""} ${chunk.content}`.slice(0, 10000)
        );
      } catch (err) {
        console.error(`Failed to embed chunk ${chunk.id}:`, err);
      }
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
