/**
 * Shared corpus plumbing for the eval probes.
 *
 * Everything corpus-specific — the repo being measured, the queries, the
 * expected results — lives in `tests/eval/.local/`, which is gitignored: the
 * corpus is a private project and this repo is public. The probes themselves
 * stay generic so they can be committed.
 */
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export const LOCAL_DIR = join(import.meta.dir, ".local");

export interface EvalQuery {
  kind: "topic" | "definition" | "knowledge" | string;
  q: string;
  /** Optional expected hits, as `filepath` or `filepath::name` — never chunk ids. */
  expect?: string[];
  note?: string;
}

interface QueriesFile {
  corpus?: { name?: string; root?: string; sha?: string | null; note?: string };
  queries: EvalQuery[];
}

function readQueriesFile(): QueriesFile {
  const path = join(LOCAL_DIR, "queries.json");
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}.\n` +
        `The eval corpus is local configuration — see tests/eval/README.md for the shape ` +
        `of queries.json and how to point it at a repo.`
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as QueriesFile;
}

export function loadQueries(): EvalQuery[] {
  const { queries } = readQueriesFile();
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error("queries.json contains no queries.");
  }
  return queries;
}

/** The corpus commit the ground truth was labelled against, if pinned. */
export function corpusSha(): string | null {
  return readQueriesFile().corpus?.sha ?? null;
}

/** Corpus repo root: CODERECALL_EVAL_CORPUS wins, else `corpus.root` from queries.json. */
export function corpusRoot(): string {
  const fromEnv = process.env.CODERECALL_EVAL_CORPUS;
  const raw = fromEnv || readQueriesFile().corpus?.root;
  if (!raw) {
    throw new Error("No corpus root. Set CODERECALL_EVAL_CORPUS or `corpus.root` in .local/queries.json.");
  }
  return resolve(raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw);
}

/**
 * Path to the index being measured. Always a copy: opening a developer's live
 * `.coderecall/index.db` read-write risks their working index.
 */
export function requireProbeDb(): string {
  const db = process.env.PROBE_DB;
  if (!db) {
    throw new Error("Set PROBE_DB to a *copy* of an index. Never point it at a live .coderecall/index.db.");
  }
  if (!existsSync(db)) throw new Error(`PROBE_DB does not exist: ${db}`);
  const live = join(corpusRootSafe() ?? "", ".coderecall", "index.db");
  if (live && resolve(db) === live) {
    throw new Error(`Refusing to run against the live index at ${live}. Copy it first.`);
  }
  return db;
}

function corpusRootSafe(): string | null {
  try {
    return corpusRoot();
  } catch {
    return null;
  }
}

/** Paths present in the index but absent from the corpus working tree. */
export function loadPhantoms(): Set<string> {
  const path = join(LOCAL_DIR, "phantoms.txt");
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Generate it with the snippet in tests/eval/README.md.`);
  }
  return new Set(
    readFileSync(path, "utf-8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}
