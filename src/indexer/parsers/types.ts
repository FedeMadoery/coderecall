import type { ChunkType, Visibility } from "../../types";

export interface ParsedChunk {
  chunk_type: ChunkType;
  visibility: Visibility;
  name: string;
  content: string;
  start_line: number;
  end_line: number;
  parent_name: string | null;
  signature: string | null;
  docstring: string | null;
}

export interface LanguageParser {
  /** Parse source code into chunks (modules, classes, functions, etc.) */
  parse(code: string): ParsedChunk[];
  /** Human-readable name used for the file's `language` column. */
  readonly language: string;
}
