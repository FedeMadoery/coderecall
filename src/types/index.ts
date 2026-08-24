// Core types for coderecall MCP Server

export type KnowledgeCategory = "architecture" | "decision" | "pattern" | "note" | "troubleshooting";

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface CodeFile {
  id: string;
  filepath: string;
  language: string;
  content_hash: string;
  indexed_at: string;
}

export type ChunkType = "module" | "class" | "function" | "method" | "block";
export type Visibility = "public" | "private" | null;

export interface CodeChunk {
  id: string;
  file_id: string;
  chunk_type: ChunkType;
  visibility: Visibility;
  name: string;
  content: string;
  start_line: number;
  end_line: number;
  parent_id: string | null;
  signature: string | null;
  docstring: string | null;
}

export interface Embedding {
  id: string;
  source_type: "code" | "knowledge";
  source_id: string;
  vector: Float32Array;
  model: string;
}

export interface SearchResult {
  type: "code" | "knowledge";
  id: string;
  score: number;
  filepath?: string;
  name?: string;
  start_line?: number;
  end_line?: number;
  signature?: string;
  title?: string;
  category?: string;
  tags?: string[];
  content: string;
}

export interface TieredResult {
  id: string;
  type: "code" | "knowledge";
  score: number;
  confidence: "high" | "medium" | "low";
  expansion: "full" | "summary" | "metadata";
  filepath?: string;
  name?: string;
  start_line?: number;
  end_line?: number;
  signature?: string;
  title?: string;
  category?: string;
  tags?: string[];
  content?: string;
  summary?: string;
}

export type ExpansionMode = "all" | "selective" | "metadata_only";

export interface IndexStats {
  total_files: number;
  total_chunks: number;
  total_knowledge: number;
  total_embeddings: number;
  last_indexed: string | null;
}

export type IndexFreshnessStatus = "unknown" | "fresh" | "stale" | "very_stale";

export interface IndexFreshness {
  lastIndexRun: string | null;
  daysOld: number | null;
  status: IndexFreshnessStatus;
  staleAfterDays: number;
  veryStaleAfterDays: number;
}

export interface IndexDiffResult {
  added: number;
  modified: number;
  deleted: number;
  time_ms: number;
}

export interface IndexFilesResult {
  files_indexed: number;
  chunks_created: number;
  time_ms: number;
  /** Files dropped from the index because they no longer exist in the scan. */
  files_pruned: number;
  /** Paths of the pruned files, so callers can show what was removed. */
  pruned_paths: string[];
}
