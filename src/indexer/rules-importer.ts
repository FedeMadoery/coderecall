import { readFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { createHash } from "crypto";
import type { MemoryDatabase } from "../storage/database";
import type { EmbeddingManager } from "../embeddings/manager";

export interface RulesImportOptions {
  filePath: string;
  followLinks?: boolean; // Default: true
  dryRun?: boolean;
  incremental?: boolean;
}

export interface RulesSection {
  name: string; // e.g., "usage_rules:elixir", "ash", "phoenix:liveview"
  title: string; // e.g., "Elixir Core Usage Rules"
  content: string; // Actual content (from inline or linked file)
  linkedFile?: string; // If content came from a linked file
  tags: string[];
  contentHash: string;
}

export interface RulesImportResult {
  total_sections: number;
  imported: number;
  skipped: number;
  errors: number;
  time_ms: number;
  sections: Array<{
    name: string;
    status: "imported" | "skipped" | "error";
    reason?: string;
    source?: "inline" | "linked";
  }>;
}

export class RulesImporter {
  constructor(
    private db: MemoryDatabase,
    private embeddings: EmbeddingManager
  ) {}

  async importRules(options: RulesImportOptions): Promise<RulesImportResult> {
    const startTime = Date.now();
    const result: RulesImportResult = {
      total_sections: 0,
      imported: 0,
      skipped: 0,
      errors: 0,
      time_ms: 0,
      sections: []
    };

    const followLinks = options.followLinks !== false; // Default true

    if (!existsSync(options.filePath)) {
      throw new Error(`File does not exist: ${options.filePath}`);
    }

    const content = readFileSync(options.filePath, "utf-8");
    const baseDir = dirname(resolve(options.filePath));

    // Parse all sections
    const sections = this.parseSections(content, baseDir, followLinks);
    result.total_sections = sections.length;

    console.log(`Found ${sections.length} sections`);

    // Get existing hashes for incremental import
    const existingHashes = new Map<string, string>();
    if (options.incremental) {
      const existing = this.db.listKnowledge();
      for (const entry of existing) {
        const hashTag = entry.tags?.find((t) => t.startsWith("__hash:"));
        if (hashTag) {
          existingHashes.set(entry.title, hashTag.replace("__hash:", ""));
        }
      }
    }

    for (const section of sections) {
      try {
        // Skip if unchanged (incremental mode)
        if (options.incremental) {
          const existingHash = existingHashes.get(section.title);
          if (existingHash === section.contentHash) {
            result.skipped++;
            result.sections.push({
              name: section.name,
              status: "skipped",
              reason: "unchanged",
              source: section.linkedFile ? "linked" : "inline"
            });
            continue;
          }
        }

        if (options.dryRun) {
          result.imported++;
          result.sections.push({
            name: section.name,
            status: "imported",
            reason: "dry-run",
            source: section.linkedFile ? "linked" : "inline"
          });
          console.log(`[DRY-RUN] Would import: ${section.name}`);
          console.log(`  Title: ${section.title}`);
          console.log(`  Source: ${section.linkedFile || "inline"}`);
          console.log(`  Tags: ${section.tags.join(", ")}`);
          console.log(`  Content length: ${section.content.length} chars`);
          continue;
        }

        // Import the section
        await this.importSection(section);
        result.imported++;
        result.sections.push({
          name: section.name,
          status: "imported",
          source: section.linkedFile ? "linked" : "inline"
        });
        console.log(`Imported: ${section.name} (${section.linkedFile ? "from " + section.linkedFile : "inline"})`);
      } catch (err) {
        result.errors++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.sections.push({
          name: section.name,
          status: "error",
          reason: errorMsg
        });
        console.error(`Error importing ${section.name}: ${errorMsg}`);
      }
    }

    result.time_ms = Date.now() - startTime;
    return result;
  }

  private parseSections(content: string, baseDir: string, followLinks: boolean): RulesSection[] {
    const sections: RulesSection[] = [];

    // Remove outer wrapper sections that contain everything
    // These wrappers prevent nested sections from being found
    let processedContent = content;
    processedContent = processedContent.replace(/<!--\s*usage-rules-start\s*-->/, "");
    processedContent = processedContent.replace(/<!--\s*usage-rules-end\s*-->/, "");
    processedContent = processedContent.replace(
      /<!--\s*usage-rules-header\s*-->[\s\S]*?<!--\s*usage-rules-header-end\s*-->/,
      ""
    );

    // Match <!-- name-start --> ... <!-- name-end --> patterns
    const sectionRegex = /<!--\s*(\S+)-start\s*-->([\s\S]*?)<!--\s*\1-end\s*-->/g;

    let match;
    while ((match = sectionRegex.exec(processedContent)) !== null) {
      const name = match[1]!;
      const sectionContent = match[2]!.trim();

      // Skip any remaining wrapper/header sections
      if (name === "usage-rules" || name === "usage-rules-header") continue;

      // Check for linked file
      const linkMatch = sectionContent.match(/\[([^\]]+)\]\(([^)]+\.md)\)/);
      let finalContent = sectionContent;
      let linkedFile: string | undefined;

      if (linkMatch && followLinks) {
        const linkPath = linkMatch[2]!;
        const absolutePath = resolve(baseDir, linkPath);

        if (existsSync(absolutePath)) {
          try {
            finalContent = readFileSync(absolutePath, "utf-8");
            linkedFile = linkPath;
          } catch (err) {
            console.warn(`Warning: Could not read linked file ${linkPath}: ${err}`);
          }
        } else {
          console.warn(`Warning: Linked file not found: ${linkPath}`);
        }
      }

      // Extract title from content
      const title = this.extractTitle(name, finalContent);

      // Extract tags from section name
      const tags = this.extractTags(name);

      // Generate content hash
      const contentHash = createHash("sha256").update(finalContent).digest("hex").slice(0, 16);

      sections.push({
        name,
        title,
        content: finalContent,
        linkedFile,
        tags,
        contentHash
      });
    }

    return sections;
  }

  private extractTitle(name: string, content: string): string {
    // Try to find H1 or H2 title in content
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match && h1Match[1]) {
      return h1Match[1].trim();
    }

    const h2Match = content.match(/^##\s+(.+)$/m);
    if (h2Match && h2Match[1]) {
      return h2Match[1].trim().replace(/\s+usage$/, " Usage Rules");
    }

    // Fall back to formatted name
    return this.formatName(name) + " Usage Rules";
  }

  private formatName(name: string): string {
    // Convert "usage_rules:elixir" → "Elixir"
    // Convert "phoenix:liveview" → "Phoenix LiveView"
    // Convert "ash_graphql" → "Ash GraphQL"

    const parts = name.split(/[_:]/);
    return parts
      .filter((p) => p !== "usage" && p !== "rules")
      .map((p) => {
        // Special cases
        if (p === "graphql") return "GraphQL";
        if (p === "otp") return "OTP";
        if (p === "api") return "API";
        if (p === "json") return "JSON";
        if (p === "html") return "HTML";
        if (p === "ecto") return "Ecto";
        if (p === "liveview") return "LiveView";
        // Default: capitalize first letter
        return p.charAt(0).toUpperCase() + p.slice(1);
      })
      .join(" ");
  }

  private extractTags(name: string): string[] {
    const tags = new Set<string>();

    // Split by : and _ to get component parts
    const parts = name.split(/[_:]/);

    for (const part of parts) {
      if (part && part !== "usage" && part !== "rules" && part !== "start" && part !== "end") {
        tags.add(part.toLowerCase());
      }
    }

    // Add general tag
    tags.add("usage-rules");

    // Add source marker
    tags.add("agents-md");

    return Array.from(tags);
  }

  private async importSection(section: RulesSection): Promise<void> {
    // Delete existing entry with same title (for updates)
    const existing = this.db.getKnowledgeByTitle(section.title);
    if (existing) {
      this.db.deleteKnowledge(existing.id);
    }

    // Add hash to tags for incremental tracking
    const tagsWithHash = [...section.tags, `__hash:${section.contentHash}`];

    // Create knowledge entry - usage rules are patterns
    const entry = this.db.addKnowledge({
      title: section.title,
      content: section.content,
      category: "pattern",
      tags: tagsWithHash
    });

    // Generate embedding
    const textForEmbedding = `${section.title}\n\n${section.content.slice(0, 8000)}`;
    const vector = await this.embeddings.embed(textForEmbedding);
    this.db.saveEmbedding("knowledge", entry.id, vector, this.embeddings.getModelName());

    // Index for FTS
    this.db.indexForFTS(entry.id, "knowledge", section.title, section.content);
  }
}
