import { readFileSync, existsSync } from "fs";
import { basename, dirname, relative } from "path";
import { createHash } from "crypto";
import type { MemoryDatabase } from "../storage/database";
import type { EmbeddingManager } from "../embeddings/manager";
import type { KnowledgeCategory } from "../types";

export interface MarkdownFrontmatter {
  tags?: string[];
  category?: string;
  title?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface MarkdownFile {
  filepath: string;
  relativePath: string;
  title: string;
  content: string;
  frontmatter: MarkdownFrontmatter;
  category: KnowledgeCategory;
  tags: string[];
  contentHash: string;
}

export interface SingleFileImportOptions {
  filePath: string;
  category?: KnowledgeCategory;
  dryRun?: boolean;
  incremental?: boolean;
}

export interface SingleFileImportResult {
  status: "imported" | "skipped" | "error";
  title: string;
  category: string;
  tags: string[];
  reason?: string;
  time_ms: number;
}

export class MarkdownImporter {
  constructor(
    private db: MemoryDatabase,
    private embeddings: EmbeddingManager
  ) {}

  /**
   * Import a single markdown file as a knowledge entry
   */
  async importSingleFile(options: SingleFileImportOptions): Promise<SingleFileImportResult> {
    const startTime = Date.now();

    if (!existsSync(options.filePath)) {
      return {
        status: "error",
        title: "",
        category: "",
        tags: [],
        reason: `File does not exist: ${options.filePath}`,
        time_ms: Date.now() - startTime
      };
    }

    try {
      // Parse file using dirname as base for relative path calculation
      const basePath = dirname(options.filePath);
      const markdownFile = this.parseFile(options.filePath, basePath);

      // Override category if provided
      if (options.category) {
        markdownFile.category = options.category;
      }

      // Check incremental hash
      if (options.incremental) {
        const existing = this.db.listKnowledge().find((k) => k.title === markdownFile.title);
        if (existing) {
          const hashTag = existing.tags?.find((t) => t.startsWith("__hash:"));
          if (hashTag && hashTag.replace("__hash:", "") === markdownFile.contentHash) {
            return {
              status: "skipped",
              title: markdownFile.title,
              category: markdownFile.category,
              tags: markdownFile.tags,
              reason: "unchanged",
              time_ms: Date.now() - startTime
            };
          }
        }
      }

      if (options.dryRun) {
        console.log(`[DRY-RUN] Would import: ${markdownFile.relativePath}`);
        console.log(`  Title: ${markdownFile.title}`);
        console.log(`  Category: ${markdownFile.category}`);
        console.log(`  Tags: ${markdownFile.tags.join(", ")}`);
        return {
          status: "imported",
          title: markdownFile.title,
          category: markdownFile.category,
          tags: markdownFile.tags,
          reason: "dry-run",
          time_ms: Date.now() - startTime
        };
      }

      // Import the file
      await this.saveToDatabase(markdownFile);

      return {
        status: "imported",
        title: markdownFile.title,
        category: markdownFile.category,
        tags: markdownFile.tags,
        time_ms: Date.now() - startTime
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        title: "",
        category: "",
        tags: [],
        reason: errorMsg,
        time_ms: Date.now() - startTime
      };
    }
  }

  /**
   * Parse a markdown file into a MarkdownFile structure
   */
  parseFile(filepath: string, basePath: string): MarkdownFile {
    const content = readFileSync(filepath, "utf-8");
    const relativePath = relative(basePath, filepath);

    // Parse frontmatter
    const frontmatter = this.parseFrontmatter(content);

    // Extract title from frontmatter, H1, or filename
    const title = this.extractTitle(content, filepath, frontmatter);

    // Remove frontmatter from content for storage
    const cleanContent = this.removeFrontmatter(content);

    // Determine category from folder structure or frontmatter
    const category = this.determineCategory(relativePath, frontmatter);

    // Extract tags from frontmatter and content
    const tags = this.extractTags(relativePath, frontmatter, cleanContent);

    // Generate content hash for incremental sync
    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);

    return {
      filepath,
      relativePath,
      title,
      content: cleanContent,
      frontmatter,
      category,
      tags,
      contentHash
    };
  }

  /**
   * Parse YAML frontmatter from markdown content
   */
  parseFrontmatter(content: string): MarkdownFrontmatter {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match || !match[1]) return {};

    const yaml = match[1];
    const frontmatter: MarkdownFrontmatter = {};

    // Simple YAML parsing (handles common cases)
    const lines = yaml.split("\n");
    let currentKey: string | null = null;
    let currentArray: string[] = [];
    let inArray = false;

    for (const line of lines) {
      // Array item
      if (line.match(/^\s+-\s+/)) {
        const value = line.replace(/^\s+-\s+/, "").trim();
        currentArray.push(value);
        continue;
      }

      // Save previous array
      if (inArray && currentKey) {
        frontmatter[currentKey] = currentArray;
        currentArray = [];
        inArray = false;
      }

      // Key-value pair
      const kvMatch = line.match(/^(\w+):\s*(.*)/);
      if (kvMatch && kvMatch[1]) {
        currentKey = kvMatch[1];
        const value = (kvMatch[2] ?? "").trim();

        if (value === "" || value === "|" || value === ">") {
          // Array or multiline starts on next line
          inArray = true;
          currentArray = [];
        } else if (currentKey) {
          frontmatter[currentKey] = value;
        }
      }
    }

    // Save last array
    if (inArray && currentKey) {
      frontmatter[currentKey] = currentArray;
    }

    return frontmatter;
  }

  /**
   * Extract title from frontmatter, H1 heading, or filename
   */
  extractTitle(content: string, filepath: string, frontmatter: MarkdownFrontmatter): string {
    // Try frontmatter title
    if (frontmatter.title && typeof frontmatter.title === "string") {
      return frontmatter.title;
    }

    // Try first H1
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match && h1Match[1]) {
      return h1Match[1].trim();
    }

    // Fall back to filename
    return basename(filepath, ".md").replace(/-/g, " ").replace(/_/g, " ");
  }

  /**
   * Remove frontmatter from content
   */
  removeFrontmatter(content: string): string {
    return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  }

  /**
   * Determine category from path structure or frontmatter
   */
  determineCategory(
    relativePath: string,
    frontmatter: MarkdownFrontmatter
  ): KnowledgeCategory {
    // Check frontmatter first
    const fmCategory = frontmatter.category;
    if (fmCategory && ["architecture", "decision", "pattern", "note", "troubleshooting"].includes(String(fmCategory))) {
      return fmCategory as KnowledgeCategory;
    }

    // Map folder structure to category
    const pathLower = relativePath.toLowerCase();

    if (pathLower.includes("/architecture/") || pathLower.endsWith("index.md")) {
      return "architecture";
    }
    if (pathLower.includes("/guides/") || pathLower.includes("/patterns/")) {
      return "pattern";
    }
    if (pathLower.includes("/workflows/") || pathLower.includes("/decisions/") || pathLower.includes("/jobs/")) {
      return "decision";
    }
    if (pathLower.includes("/resources/") || pathLower.includes("/reference/")) {
      return "note";
    }

    // Default based on frontmatter tags
    const tags = frontmatter.tags;
    if (Array.isArray(tags)) {
      if (tags.includes("architecture") || tags.includes("moc")) return "architecture";
      if (tags.includes("guide") || tags.includes("pattern")) return "pattern";
      if (tags.includes("decision") || tags.includes("workflow")) return "decision";
    }

    return "note";
  }

  /**
   * Extract tags from frontmatter, path, and inline #tags
   */
  extractTags(relativePath: string, frontmatter: MarkdownFrontmatter, content: string): string[] {
    const tags = new Set<string>();

    // Add frontmatter tags
    if (Array.isArray(frontmatter.tags)) {
      for (const tag of frontmatter.tags) {
        if (typeof tag === "string" && !tag.startsWith("__")) {
          tags.add(tag.toLowerCase());
        }
      }
    }

    // Add domain from path (first directory)
    const pathParts = relativePath.split("/");
    if (pathParts.length > 1 && pathParts[0]) {
      tags.add(pathParts[0].toLowerCase().replace(/\s+/g, "-"));
    }

    // Extract inline tags from content (#tag)
    const inlineTags = content.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/g);
    if (inlineTags) {
      for (const tag of inlineTags.slice(0, 10)) {
        // Limit to 10 inline tags
        tags.add(tag.slice(1).toLowerCase());
      }
    }

    // Add source marker
    tags.add("markdown");

    return Array.from(tags);
  }

  /**
   * Save a markdown file to the database with embedding and FTS indexing
   */
  async saveToDatabase(file: MarkdownFile): Promise<void> {
    // Delete existing entry with same title (for updates)
    const existing = this.db.listKnowledge().find((k) => k.title === file.title);
    if (existing) {
      this.db.deleteKnowledge(existing.id);
    }

    // Add hash to tags for incremental tracking
    const tagsWithHash = [...file.tags, `__hash:${file.contentHash}`];

    // Create knowledge entry
    const entry = this.db.addKnowledge({
      title: file.title,
      content: file.content,
      category: file.category,
      tags: tagsWithHash
    });

    // Generate embedding
    const textForEmbedding = `${file.title}\n\n${file.content.slice(0, 8000)}`; // Limit for embedding
    const vector = await this.embeddings.embed(textForEmbedding);
    this.db.saveEmbedding("knowledge", entry.id, vector);

    // Index for FTS
    this.db.indexForFTS(entry.id, "knowledge", file.title, file.content);
  }
}
