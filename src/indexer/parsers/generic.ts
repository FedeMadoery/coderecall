import type { LanguageParser, ParsedChunk } from "./types";

/**
 * Fallback parser for unknown languages.
 * Splits the file into ~80-line blocks so the embedding model still has
 * meaningful chunk granularity even without language-specific parsing.
 */
export class GenericParser implements LanguageParser {
  readonly language: string;
  private chunkLines: number;

  constructor(language: string = "text", chunkLines: number = 80) {
    this.language = language;
    this.chunkLines = chunkLines;
  }

  parse(code: string): ParsedChunk[] {
    const lines = code.split("\n");
    const chunks: ParsedChunk[] = [];

    if (lines.length === 0) return chunks;

    let i = 0;
    let block = 1;
    while (i < lines.length) {
      const start = i;
      const end = Math.min(i + this.chunkLines, lines.length) - 1;
      chunks.push({
        chunk_type: "block",
        visibility: null,
        name: `block_${block}`,
        content: lines.slice(start, end + 1).join("\n"),
        start_line: start + 1,
        end_line: end + 1,
        parent_name: null,
        signature: null,
        docstring: null
      });
      i = end + 1;
      block++;
    }

    return chunks;
  }
}
