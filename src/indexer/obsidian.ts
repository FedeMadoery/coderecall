import { existsSync } from "fs";
import { join, relative } from "path";
import { glob } from "glob";
import type { MemoryDatabase } from "../storage/database";
import type { EmbeddingManager } from "../embeddings/manager";
import { MarkdownImporter, type MarkdownFile } from "./markdown";

export interface ObsidianImportOptions {
  vaultPath: string;
  directory?: string; // Optional subdirectory to import
  dryRun?: boolean;
  incremental?: boolean; // Only import changed files
}

export interface ImportResult {
  total_files: number;
  imported: number;
  skipped: number;
  errors: number;
  time_ms: number;
  files: Array<{ path: string; status: "imported" | "skipped" | "error"; reason?: string }>;
}

export class ObsidianImporter {
  private markdownImporter: MarkdownImporter;
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase, embeddings: EmbeddingManager) {
    this.db = db;
    this.markdownImporter = new MarkdownImporter(db, embeddings);
  }

  async importVault(options: ObsidianImportOptions): Promise<ImportResult> {
    const startTime = Date.now();
    const result: ImportResult = {
      total_files: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      time_ms: 0,
      files: []
    };

    const basePath = options.directory ? join(options.vaultPath, options.directory) : options.vaultPath;

    if (!existsSync(basePath)) {
      throw new Error(`Path does not exist: ${basePath}`);
    }

    // Find all markdown files
    const pattern = join(basePath, "**/*.md");
    const files = await glob(pattern, { nodir: true });
    result.total_files = files.length;

    console.log(`Found ${files.length} markdown files`);

    // Get existing knowledge entries for incremental import
    const existingHashes = new Map<string, string>();
    if (options.incremental) {
      const existing = this.db.listKnowledge();
      for (const entry of existing) {
        // Store hash in tags as __hash:xxx for tracking
        const hashTag = entry.tags?.find((t: string) => t.startsWith("__hash:"));
        if (hashTag) {
          existingHashes.set(entry.title, hashTag.replace("__hash:", ""));
        }
      }
    }

    for (const filepath of files) {
      try {
        const markdownFile = this.markdownImporter.parseFile(filepath, options.vaultPath);

        // Override source tag to 'obsidian' for vault imports
        this.replaceSourceTag(markdownFile, "obsidian");

        // Skip if unchanged (incremental mode)
        if (options.incremental) {
          const existingHash = existingHashes.get(markdownFile.title);
          if (existingHash === markdownFile.contentHash) {
            result.skipped++;
            result.files.push({ path: markdownFile.relativePath, status: "skipped", reason: "unchanged" });
            continue;
          }
        }

        if (options.dryRun) {
          result.imported++;
          result.files.push({ path: markdownFile.relativePath, status: "imported", reason: "dry-run" });
          console.log(`[DRY-RUN] Would import: ${markdownFile.relativePath}`);
          console.log(`  Title: ${markdownFile.title}`);
          console.log(`  Category: ${markdownFile.category}`);
          console.log(`  Tags: ${markdownFile.tags.join(", ")}`);
          continue;
        }

        // Import the file
        await this.markdownImporter.saveToDatabase(markdownFile);
        result.imported++;
        result.files.push({ path: markdownFile.relativePath, status: "imported" });
        console.log(`Imported: ${markdownFile.relativePath}`);
      } catch (err) {
        result.errors++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.files.push({ path: relative(options.vaultPath, filepath), status: "error", reason: errorMsg });
        console.error(`Error importing ${filepath}: ${errorMsg}`);
      }
    }

    result.time_ms = Date.now() - startTime;
    return result;
  }

  /**
   * Replace the source tag in a markdown file (e.g., 'markdown' -> 'obsidian')
   */
  private replaceSourceTag(file: MarkdownFile, newTag: string): void {
    const sourceIndex = file.tags.indexOf("markdown");
    if (sourceIndex !== -1) {
      file.tags[sourceIndex] = newTag;
    } else {
      file.tags.push(newTag);
    }
  }
}
