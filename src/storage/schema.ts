// SQLite schema for AI Memory

export const SCHEMA = `
-- User-added knowledge entries
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  category TEXT CHECK(category IN ('architecture', 'decision', 'pattern', 'note', 'troubleshooting')),
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Source files (with content hash for incremental updates)
CREATE TABLE IF NOT EXISTS code_files (
  id TEXT PRIMARY KEY,
  filepath TEXT NOT NULL UNIQUE,
  language TEXT,
  content_hash TEXT,
  indexed_at TEXT DEFAULT (datetime('now'))
);

-- Code chunks (modules, classes, functions, methods, etc.)
-- chunk_type is intentionally general; visibility holds public/private (or NULL for languages without that concept).
CREATE TABLE IF NOT EXISTS code_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  chunk_type TEXT CHECK(chunk_type IN ('module', 'class', 'function', 'method', 'block')),
  visibility TEXT CHECK(visibility IN ('public', 'private') OR visibility IS NULL),
  name TEXT,
  content TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  parent_id TEXT,
  signature TEXT,
  docstring TEXT,
  FOREIGN KEY (file_id) REFERENCES code_files(id) ON DELETE CASCADE
);

-- Unified embeddings (for both code and knowledge)
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  source_type TEXT CHECK(source_type IN ('code', 'knowledge')),
  source_id TEXT NOT NULL,
  vector BLOB NOT NULL,
  model TEXT
);

-- Full-text search (unified)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  source_id,
  source_type,
  name,
  content,
  tokenize='porter'
);

-- Key-value metadata (e.g. last_index_run timestamp for staleness checks)
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_parent ON code_chunks(parent_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_code_files_path ON code_files(filepath);
`;

export const DROP_SCHEMA = `
DROP TABLE IF EXISTS embeddings;
DROP TABLE IF EXISTS code_chunks;
DROP TABLE IF EXISTS code_files;
DROP TABLE IF EXISTS knowledge_entries;
DROP TABLE IF EXISTS memory_fts;
DROP TABLE IF EXISTS meta;
`;
