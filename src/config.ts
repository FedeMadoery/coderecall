import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

export interface CoderecallConfig {
  /** Where the SQLite index lives (absolute or relative to project root). */
  indexPath: string;
  /** Project root used as the base path for indexing. */
  projectRoot: string;
  /** File extensions to index (including leading dot). */
  extensions: string[];
  /** Glob patterns to skip during scanning. */
  ignore: string[];
  /** HuggingFace-style identifier for the embedding model. */
  embeddingModel: string;
  /** Days before the index is considered stale (yellow warning in search output). */
  staleAfterDays: number;
  /** Days before the index is considered very stale (red warning). */
  veryStaleAfterDays: number;
  /** Auto-detected language hint (informational only). */
  language?: string;
}

export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/out/**",
  "**/coverage/**",
  "**/.git/**",
  "**/_build/**",
  "**/deps/**",
  "**/target/**",
  "**/vendor/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.tox/**",
  "**/.elixir_ls/**",
  "**/priv/static/**",
  "**/.coderecall/**"
];

export const DEFAULTS: CoderecallConfig = {
  indexPath: ".coderecall",
  projectRoot: process.cwd(),
  extensions: [".ts", ".tsx", ".js", ".jsx"],
  ignore: DEFAULT_IGNORE,
  embeddingModel: "Xenova/bge-small-en-v1.5",
  staleAfterDays: 14,
  veryStaleAfterDays: 30
};

/**
 * Resolve config from (in order of precedence):
 * 1. Environment variables (CODERECALL_*)
 * 2. .coderecall.json in projectRoot
 * 3. Defaults
 */
export function loadConfig(projectRoot: string = process.cwd()): CoderecallConfig {
  const root = resolve(projectRoot);
  let fromFile: Partial<CoderecallConfig> = {};

  const configPath = join(root, ".coderecall.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fromFile = JSON.parse(raw);
    } catch (err) {
      console.error(`Failed to parse ${configPath}: ${(err as Error).message}`);
    }
  }

  const env = {
    indexPath: process.env.CODERECALL_INDEX_PATH,
    extensions: process.env.CODERECALL_EXTENSIONS?.split(",").map((s) => s.trim()).filter(Boolean),
    embeddingModel: process.env.CODERECALL_EMBEDDING_MODEL,
    ignore: process.env.CODERECALL_IGNORE?.split(",").map((s) => s.trim()).filter(Boolean)
  };

  const merged: CoderecallConfig = {
    projectRoot: root,
    indexPath: env.indexPath || fromFile.indexPath || DEFAULTS.indexPath,
    extensions: env.extensions || fromFile.extensions || DEFAULTS.extensions,
    ignore: env.ignore || fromFile.ignore || DEFAULTS.ignore,
    embeddingModel: env.embeddingModel || fromFile.embeddingModel || DEFAULTS.embeddingModel,
    staleAfterDays: fromFile.staleAfterDays ?? DEFAULTS.staleAfterDays,
    veryStaleAfterDays: fromFile.veryStaleAfterDays ?? DEFAULTS.veryStaleAfterDays,
    language: fromFile.language
  };

  return merged;
}

/** Detect the dominant language by scanning for well-known manifest files. */
export function detectLanguage(projectRoot: string): {
  language: string;
  extensions: string[];
} | null {
  const checks: Array<{ file: string; language: string; extensions: string[] }> = [
    { file: "mix.exs", language: "elixir", extensions: [".ex", ".exs"] },
    { file: "Cargo.toml", language: "rust", extensions: [".rs"] },
    { file: "go.mod", language: "go", extensions: [".go"] },
    { file: "pyproject.toml", language: "python", extensions: [".py"] },
    { file: "requirements.txt", language: "python", extensions: [".py"] },
    { file: "Pipfile", language: "python", extensions: [".py"] },
    { file: "Gemfile", language: "ruby", extensions: [".rb"] },
    { file: "tsconfig.json", language: "typescript", extensions: [".ts", ".tsx"] },
    { file: "package.json", language: "javascript", extensions: [".ts", ".tsx", ".js", ".jsx"] }
  ];

  for (const check of checks) {
    if (existsSync(join(projectRoot, check.file))) {
      return { language: check.language, extensions: check.extensions };
    }
  }

  return null;
}
