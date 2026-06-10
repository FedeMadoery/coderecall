/**
 * Chunk Summarizer
 *
 * Generates compact summaries for medium-confidence results — preserves
 * the key signal (signature + first docstring line) while saving context.
 */

import type { CodeChunk, KnowledgeEntry } from "../types";

export interface SummaryOptions {
  maxLength: number;
  includeSignature: boolean;
  includeDocstring: boolean;
}

const DEFAULT_OPTIONS: SummaryOptions = {
  maxLength: 200,
  includeSignature: true,
  includeDocstring: true
};

export class ChunkSummarizer {
  private options: SummaryOptions;

  constructor(options: Partial<SummaryOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Summarize a code chunk
   * Returns: function signature + first docstring line (if available)
   */
  summarizeCode(chunk: CodeChunk): string {
    const parts: string[] = [];

    // Add signature if available and enabled
    if (this.options.includeSignature && chunk.signature) {
      parts.push(chunk.signature);
    } else if (chunk.name) {
      // Fallback to name with type
      parts.push(`${chunk.chunk_type} ${chunk.name}`);
    }

    // Add first line of docstring if available
    if (this.options.includeDocstring && chunk.docstring) {
      const firstLine = this.extractFirstMeaningfulLine(chunk.docstring);
      if (firstLine) {
        parts.push(firstLine);
      }
    }

    // If we still have room, add abbreviated content
    const summary = parts.join("\n");
    if (summary.length < this.options.maxLength && chunk.content) {
      const remainingSpace = this.options.maxLength - summary.length - 10;
      if (remainingSpace > 50) {
        const contentPreview = this.truncateContent(chunk.content, remainingSpace);
        if (contentPreview && !summary.includes(contentPreview)) {
          parts.push(`...\n${contentPreview}`);
        }
      }
    }

    return this.truncate(parts.join("\n"), this.options.maxLength);
  }

  /**
   * Summarize a knowledge entry
   * Returns: title + first 150 chars of content
   */
  summarizeKnowledge(entry: KnowledgeEntry): string {
    const parts: string[] = [];

    // Always include title
    parts.push(`# ${entry.title}`);

    // Add category as context
    if (entry.category) {
      parts.push(`[${entry.category}]`);
    }

    // Add truncated content
    if (entry.content) {
      const contentPreview = this.extractFirstMeaningfulLine(entry.content);
      if (contentPreview) {
        parts.push(contentPreview);
      }
    }

    return this.truncate(parts.join("\n"), this.options.maxLength);
  }

  /**
   * Generate metadata-only representation (minimal context)
   */
  generateMetadata(item: CodeChunk | KnowledgeEntry, type: "code" | "knowledge"): string {
    if (type === "code") {
      const chunk = item as CodeChunk;
      return `${chunk.chunk_type}: ${chunk.name} (lines ${chunk.start_line}-${chunk.end_line})`;
    } else {
      const entry = item as KnowledgeEntry;
      const tagStr = entry.tags?.slice(0, 3).join(", ") || "";
      return `${entry.title} [${entry.category}]${tagStr ? ` #${tagStr}` : ""}`;
    }
  }

  /**
   * Extract the first meaningful line from text
   * Skips empty lines and common prefixes
   */
  private extractFirstMeaningfulLine(text: string): string | null {
    const lines = text.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) continue;

      // Skip common documentation prefixes
      if (trimmed.startsWith("@") || trimmed.startsWith("#")) continue;

      // Skip very short lines (likely just punctuation)
      if (trimmed.length < 10) continue;

      return this.truncate(trimmed, 150);
    }

    return null;
  }

  /**
   * Truncate content intelligently (at word boundaries)
   */
  private truncateContent(content: string, maxLength: number): string {
    // Skip leading whitespace and common patterns
    const cleaned = content.replace(/^\s+/, "").replace(/^@\w+.*\n/gm, "");

    if (cleaned.length <= maxLength) {
      return cleaned;
    }

    // Find last space before limit
    const truncated = cleaned.slice(0, maxLength);
    const lastSpace = truncated.lastIndexOf(" ");

    if (lastSpace > maxLength * 0.7) {
      return truncated.slice(0, lastSpace) + "...";
    }

    return truncated + "...";
  }

  /**
   * Truncate string to max length
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength - 3) + "...";
  }
}
