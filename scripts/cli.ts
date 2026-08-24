#!/usr/bin/env bun
import { MemoryDatabase } from "../src/storage/database";
import { EmbeddingManager } from "../src/embeddings/manager";
import { HybridSearch } from "../src/search/hybrid";
import { CodeChunker } from "../src/indexer/chunker";
import { FileScanner } from "../src/indexer/scanner";
import { ObsidianImporter } from "../src/indexer/obsidian";
import { MarkdownImporter } from "../src/indexer/markdown";
import { loadConfig, detectLanguage, DEFAULT_IGNORE, DEFAULTS, LANGUAGE_PRESETS, parseExtensions } from "../src/config";
import type { LanguagePreset } from "../src/config";

import type { ExpansionMode, IndexFreshness } from "../src/types";
import { join, resolve, isAbsolute, dirname, relative, sep } from "path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);
const command = args[0];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const SERVER_ENTRY = join(PACKAGE_ROOT, "src", "index.ts");

function printUsage() {
  console.log(`
coderecall CLI

Usage:
  coderecall <command> [options]

Commands:
  init [path]               Initialize in a project (detects language, writes .coderecall.json + .mcp.json)
  index [path]              Index a directory (defaults to project root from config)
  index-diff [path]         Index only changed files (git diff)
  search <query>            Search the index (confidence-tiered expansion)
  search-legacy <query>     Search with full expansion (no tiering)
  stats                     Show index statistics
  add-knowledge             Add a knowledge entry (interactive)
  import-obsidian --vault <path>      Import knowledge from an Obsidian vault
  import-knowledge-file <file>        Import a single markdown file as knowledge
  list-knowledge            List all knowledge entries

Init options:
  --force                   Overwrite existing .coderecall.json / .mcp.json
  --client <name>           Target MCP client (claude-code, cursor, generic). Default: claude-code
  --no-mcp                  Don't write .mcp.json
  --no-config               Don't write .coderecall.json
  --language <name>         Language preset (typescript, javascript, python, ruby, go, rust,
                            elixir, java, kotlin, swift, csharp, cpp, php). Overrides auto-detection.
  --extensions <exts>       Comma-separated extensions (e.g. ".py,.pyx"). Overrides auto-detection.

Indexing options:
  --extensions <exts>       Comma-separated file extensions (defaults to config)
  --no-git-ls               Skip 'git ls-files'; use glob walk instead (pyvenv.cfg detection added for Python projects)
  --no-prune                Keep index entries for files that no longer exist. A full-project 'index'
                            prunes deleted/renamed files by default; scoped scans never prune.
  --base <ref>              Base git ref for diff (default: HEAD~1)
  --head <ref>              Head git ref for diff (default: HEAD)

Search options:
  --filter <type>           all | code | knowledge
  --limit <n>               Limit results (default: 10)
  --expansion <mode>        selective | all | metadata_only

Examples:
  coderecall init                          # plug-and-play setup in current project
  coderecall index                         # uses extensions from .coderecall.json
  coderecall index ./src --extensions .py
  coderecall search "how does auth work"
  coderecall stats
`);
}

interface ParsedOptions {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedOptions {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

async function main() {
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  const parsed = parseArgs(args.slice(1));

  // ---------------- init (no DB needed) ----------------
  if (command === "init") {
    return runInit(parsed);
  }

  // ---------------- Everything else: open DB ----------------
  const projectRoot = process.env.CODERECALL_PROJECT_ROOT
    ? resolve(process.env.CODERECALL_PROJECT_ROOT)
    : process.cwd();
  const config = loadConfig(projectRoot);

  const indexPathOption = typeof parsed.flags["db"] === "string" ? (parsed.flags["db"] as string) : undefined;
  const indexPath = indexPathOption
    ? resolve(indexPathOption)
    : isAbsolute(config.indexPath)
      ? config.indexPath
      : join(projectRoot, config.indexPath);
  const dbPath = indexPath.endsWith(".db") ? indexPath : join(indexPath, "index.db");

  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    // exists
  }

  const db = new MemoryDatabase(dbPath);
  const embeddings = new EmbeddingManager(config.embeddingModel);
  await embeddings.init();

  const search = new HybridSearch(db, embeddings);
  const chunker = new CodeChunker(db, embeddings);

  // A width mismatch makes vector search fail silently, so say so up front
  // rather than letting results quietly degrade to keyword-only.
  const compat = db.checkEmbeddingCompatibility(embeddings.getModelName(), embeddings.getDimension());
  if (!compat.ok) {
    console.error(`⚠️  Embedding model mismatch: ${compat.reason}`);
  }

  try {
    switch (command) {
      case "index": {
        const targetPath = parsed.positionals[0] || projectRoot;
        const extensions =
          (typeof parsed.flags["extensions"] === "string" ? (parsed.flags["extensions"] as string).split(",") : null) ||
          config.extensions;
        const absolutePath = resolve(targetPath);

        console.log(`Indexing ${absolutePath}...`);
        console.log(`Extensions: ${extensions.join(", ")}`);

        const useGit = !parsed.flags["no-git-ls"];
        const scanner = new FileScanner(absolutePath, { extensions, ignore: config.ignore, useGit });
        const files = await scanner.scanAll();
        console.log(`Found ${files.length} files`);

        // Pruning compares the scan against the entire index, so it is only
        // sound for a full project-root scan. A scoped run (`index ./src`) also
        // stores paths relative to that subdirectory, which makes them
        // indistinguishable from root-relative ones — another reason not to
        // prune on anything but the root.
        const isFullScan = absolutePath === resolve(projectRoot);
        const pruneOptOut = "no-prune" in parsed.flags;
        const prune = isFullScan && !pruneOptOut;

        if (!isFullScan) {
          console.log(`Scoped scan — skipping prune (only full-project scans prune).`);
        } else if (pruneOptOut) {
          console.log(`Pruning disabled via --no-prune.`);
        }

        const result = await chunker.indexFiles(files, { prune });
        console.log(`\nIndexing complete:`);
        console.log(`  Files indexed: ${result.files_indexed}`);
        console.log(`  Chunks created: ${result.chunks_created}`);
        if (prune) {
          console.log(`  Files pruned: ${result.files_pruned}`);
          for (const p of result.pruned_paths.slice(0, 10)) {
            console.log(`    - ${p}`);
          }
          if (result.pruned_paths.length > 10) {
            console.log(`    ... and ${result.pruned_paths.length - 10} more`);
          }
        }
        console.log(`  Time: ${result.time_ms}ms`);
        break;
      }

      case "index-diff": {
        const repoPath = resolve(parsed.positionals[0] || projectRoot);
        const baseRef = (parsed.flags["base"] as string) || "HEAD~1";
        const headRef = (parsed.flags["head"] as string) || "HEAD";

        console.log(`Indexing diff from ${baseRef} to ${headRef} in ${repoPath}...`);

        const result = await chunker.indexDiff(repoPath, baseRef, headRef, {
          extensions: config.extensions,
          ignore: config.ignore
        });
        console.log(`\nIncremental indexing complete:`);
        console.log(`  Added: ${result.added}`);
        console.log(`  Modified: ${result.modified}`);
        console.log(`  Deleted: ${result.deleted}`);
        console.log(`  Time: ${result.time_ms}ms`);
        break;
      }

      case "search":
      case "search-legacy": {
        const query = parsed.positionals[0];
        if (!query) {
          console.error("Error: Please provide a search query");
          process.exit(1);
        }

        const filter = ((parsed.flags["filter"] as string) || "all") as "all" | "code" | "knowledge";
        const limit = parseInt((parsed.flags["limit"] as string) || "10");
        const expansion = ((parsed.flags["expansion"] as string) || "selective") as ExpansionMode;

        console.log(`Searching for: "${query}"`);

        const freshness = db.getIndexAge(config.staleAfterDays, config.veryStaleAfterDays);
        const banner = freshnessLine(freshness);
        if (banner) console.log(`\n${banner}\n`);

        if (command === "search-legacy") {
          const results = await search.search(query, filter, limit);
          renderLegacy(results);
        } else {
          const results = await search.tieredSearch(query, filter, limit, expansion);
          renderTiered(results);
        }
        break;
      }

      case "stats": {
        const stats = db.getStats();
        const f = db.getIndexAge(config.staleAfterDays, config.veryStaleAfterDays);
        console.log("Index Statistics:");
        console.log(`  Total files: ${stats.total_files}`);
        console.log(`  Total chunks: ${stats.total_chunks}`);
        console.log(`  Total knowledge entries: ${stats.total_knowledge}`);
        console.log(`  Total embeddings: ${stats.total_embeddings}`);
        console.log(`  Last indexed: ${stats.last_indexed || "Never"}`);
        console.log(`  Last index run: ${f.lastIndexRun || "Never"}`);
        if (f.status === "unknown") {
          console.log(`  Age: never indexed`);
        } else {
          console.log(`  Age: ${f.daysOld} days (status: ${f.status})`);
        }
        console.log(`  Project root: ${projectRoot}`);
        console.log(`  DB path: ${dbPath}`);
        const banner = freshnessLine(f);
        if (banner) console.log(`\n${banner}`);
        break;
      }

      case "add-knowledge": {
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (p: string): Promise<string> => new Promise((res) => rl.question(p, res));

        const title = await question("Title: ");
        const category = await question("Category (architecture/decision/pattern/note/troubleshooting): ");
        const tagsInput = await question("Tags (comma-separated): ");
        console.log("Content (end with empty line):");

        const contentLines: string[] = [];
        let line = await question("");
        while (line !== "") {
          contentLines.push(line);
          line = await question("");
        }
        rl.close();

        const entry = db.addKnowledge({
          title,
          content: contentLines.join("\n"),
          category: category as any,
          tags: tagsInput
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        });

        const vector = await embeddings.embed(`${entry.title}\n${entry.content}`);
        db.saveEmbedding("knowledge", entry.id, vector, embeddings.getModelName());
        db.indexForFTS(entry.id, "knowledge", entry.title, entry.content);
        console.log(`\nKnowledge entry created: ${entry.id}`);
        break;
      }

      case "import-obsidian": {
        const vaultPath = (parsed.flags["vault"] as string) || parsed.positionals[0];
        if (!vaultPath) {
          console.error("Error: Please provide vault path with --vault or as argument");
          process.exit(1);
        }
        const importer = new ObsidianImporter(db, embeddings);
        const result = await importer.importVault({
          vaultPath: resolve(vaultPath),
          directory: parsed.flags["dir"] as string | undefined,
          dryRun: !!parsed.flags["dry-run"],
          incremental: !!parsed.flags["incremental"]
        });
        console.log(`\nObsidian import complete:`);
        console.log(`  Total files found: ${result.total_files}`);
        console.log(`  Imported: ${result.imported}`);
        console.log(`  Skipped: ${result.skipped}`);
        console.log(`  Errors: ${result.errors}`);
        console.log(`  Time: ${result.time_ms}ms`);
        break;
      }

      case "import-knowledge-file": {
        const filePath = parsed.positionals[0];
        if (!filePath) {
          console.error("Error: Please provide a file path");
          process.exit(1);
        }
        const importer = new MarkdownImporter(db, embeddings);
        const result = await importer.importSingleFile({
          filePath: resolve(filePath),
          category: parsed.flags["category"] as any,
          dryRun: !!parsed.flags["dry-run"],
          incremental: !!parsed.flags["incremental"]
        });
        console.log(`\n${result.status.toUpperCase()}: ${result.title}`);
        console.log(`  Category: ${result.category}`);
        if (result.reason) console.log(`  Reason: ${result.reason}`);
        if (result.status === "error") process.exit(1);
        break;
      }

      case "list-knowledge": {
        const entries = db.listKnowledge(parsed.flags["category"] as string, parsed.flags["tag"] as string);
        if (entries.length === 0) {
          console.log("No knowledge entries found.");
        } else {
          for (const entry of entries) {
            const displayTags = entry.tags?.filter((t) => !t.startsWith("__")) || [];
            console.log(`[${entry.category?.toUpperCase() || "NOTE"}] ${entry.title}`);
            console.log(`  ID: ${entry.id}`);
            console.log(`  Tags: ${displayTags.join(", ") || "none"}`);
            console.log(`  Preview: ${entry.content.slice(0, 100).replace(/\n/g, " ")}...`);
            console.log("");
          }
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

// ==================== init ====================

async function runInit(parsed: ParsedOptions) {
  const targetRoot = resolve(parsed.positionals[0] || process.cwd());

  if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) {
    console.error(`Error: ${targetRoot} is not a directory`);
    process.exit(1);
  }

  console.log(`Initializing coderecall in: ${targetRoot}\n`);

  const flagLanguage =
    typeof parsed.flags["language"] === "string" ? (parsed.flags["language"] as string).toLowerCase() : null;
  const flagExtensions = typeof parsed.flags["extensions"] === "string" ? (parsed.flags["extensions"] as string) : null;

  const detected = detectLanguage(targetRoot);
  const chosen = await resolveLanguageChoice({ detected, flagLanguage, flagExtensions });

  if (chosen.source === "flag") {
    console.log(`Using ${chosen.language ? `language: ${chosen.language}` : "explicit extensions"}`);
    console.log(`Extensions: ${chosen.extensions.join(", ")}\n`);
  } else if (chosen.source === "detected") {
    console.log(`Detected language: ${chosen.language}`);
    console.log(`Extensions: ${chosen.extensions.join(", ")}\n`);
  } else {
    console.log(`Selected language: ${chosen.language ?? "custom"}`);
    console.log(`Extensions: ${chosen.extensions.join(", ")}\n`);
  }

  const force = !!parsed.flags["force"];
  const writeConfig = !parsed.flags["no-config"];
  const writeMcp = !parsed.flags["no-mcp"];
  const client = ((parsed.flags["client"] as string) || "claude-code").toLowerCase();

  // 1. .coderecall.json
  const configPath = join(targetRoot, ".coderecall.json");
  if (writeConfig) {
    if (existsSync(configPath) && !force) {
      console.log(`Skipping ${configPath} (exists; use --force to overwrite)`);
    } else {
      const cfg = {
        indexPath: ".coderecall",
        extensions: chosen.extensions,
        ignore: DEFAULT_IGNORE,
        embeddingModel: DEFAULTS.embeddingModel,
        staleAfterDays: DEFAULTS.staleAfterDays,
        veryStaleAfterDays: DEFAULTS.veryStaleAfterDays,
        ...(chosen.language ? { language: chosen.language } : {})
      };
      writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
      console.log(`Wrote ${configPath}`);
    }
  }

  // Detect vendored install (coderecall lives inside the target project).
  // When vendored, write a portable relative server path and omit the
  // absolute CODERECALL_PROJECT_ROOT env var — the server falls back to
  // the MCP client's launch CWD, which is the project root.
  const isVendored = PACKAGE_ROOT === targetRoot || PACKAGE_ROOT.startsWith(targetRoot + sep);

  // 2. .mcp.json (project-level Claude Code config)
  if (writeMcp) {
    const mcpPath = client === "cursor" ? join(targetRoot, ".cursor", "mcp.json") : join(targetRoot, ".mcp.json");

    const serverEntryArg = isVendored ? "./" + relative(targetRoot, SERVER_ENTRY) : SERVER_ENTRY;

    const mcpEntry: { command: string; args: string[]; env?: Record<string, string> } = {
      command: "bun",
      args: ["run", serverEntryArg]
    };
    if (!isVendored) {
      mcpEntry.env = { CODERECALL_PROJECT_ROOT: targetRoot };
    }

    let mcpDoc: { mcpServers: Record<string, unknown> };

    if (existsSync(mcpPath)) {
      try {
        mcpDoc = JSON.parse(readFileSync(mcpPath, "utf-8"));
        if (!mcpDoc.mcpServers) mcpDoc.mcpServers = {};
      } catch {
        if (!force) {
          console.log(`Skipping ${mcpPath} (parse failed; use --force to overwrite)`);
          mcpDoc = { mcpServers: {} };
        } else {
          mcpDoc = { mcpServers: {} };
        }
      }

      if (mcpDoc.mcpServers["coderecall"] && !force) {
        console.log(`Skipping ${mcpPath} (coderecall entry already exists; use --force to overwrite)`);
      } else {
        mcpDoc.mcpServers["coderecall"] = mcpEntry;
        mkdirSync(dirname(mcpPath), { recursive: true });
        writeFileSync(mcpPath, JSON.stringify(mcpDoc, null, 2) + "\n");
        console.log(`Updated ${mcpPath}`);
      }
    } else {
      mcpDoc = { mcpServers: { coderecall: mcpEntry } };
      mkdirSync(dirname(mcpPath), { recursive: true });
      writeFileSync(mcpPath, JSON.stringify(mcpDoc, null, 2) + "\n");
      console.log(`Wrote ${mcpPath}`);
    }
  }

  // 3. .gitignore hint
  const gitignorePath = join(targetRoot, ".gitignore");
  const ignoreLines = [".coderecall/"];
  if (isVendored) {
    const vendorPath = relative(targetRoot, PACKAGE_ROOT);
    if (vendorPath) ignoreLines.push(`${vendorPath}/node_modules/`);
  }
  if (existsSync(gitignorePath)) {
    let content = readFileSync(gitignorePath, "utf-8");
    let touched = false;
    for (const line of ignoreLines) {
      if (!content.split("\n").some((l) => l.trim() === line)) {
        content = content.replace(/\n*$/, "\n") + line + "\n";
        touched = true;
        console.log(`Added '${line}' to .gitignore`);
      }
    }
    if (touched) writeFileSync(gitignorePath, content);
  }

  console.log(`
Next steps:
  1. Make sure bun is installed:  curl -fsSL https://bun.sh/install | bash
  2. Index your codebase:         bunx coderecall index
  3. Restart your MCP client (Claude Code, Cursor, etc.) — the 'coderecall' tools will appear.
  4. (Optional) Add a CLAUDE.md note telling the agent to use mcp__coderecall__search before reading files.
`);
}

interface LanguageChoice {
  language: string | null;
  extensions: string[];
  source: "flag" | "detected" | "prompt";
}

async function resolveLanguageChoice(opts: {
  detected: LanguagePreset | null;
  flagLanguage: string | null;
  flagExtensions: string | null;
}): Promise<LanguageChoice> {
  // 1. Explicit flags always win, even over auto-detection.
  if (opts.flagExtensions) {
    return {
      language: opts.flagLanguage ?? null,
      extensions: parseExtensions(opts.flagExtensions),
      source: "flag"
    };
  }
  if (opts.flagLanguage) {
    const preset = LANGUAGE_PRESETS[opts.flagLanguage];
    if (!preset) {
      console.error(`Unknown --language "${opts.flagLanguage}". Known: ${Object.keys(LANGUAGE_PRESETS).join(", ")}.`);
      console.error(`Or pass extensions directly: --extensions ".foo,.bar"`);
      process.exit(1);
    }
    return { language: preset.language, extensions: preset.extensions, source: "flag" };
  }

  // 2. Manifest detection.
  if (opts.detected) {
    return { language: opts.detected.language, extensions: opts.detected.extensions, source: "detected" };
  }

  // 3. No manifest, no flags — ask interactively, or instruct the agent to ask.
  if (process.stdin.isTTY) {
    return await promptForLanguage();
  }

  console.error(`No language manifest found in this project (e.g. package.json, Cargo.toml, pyproject.toml).`);
  console.error(`coderecall needs to know which file extensions to index.`);
  console.error(``);
  console.error(`Ask the user which language(s) they want indexed, then re-run with one of:`);
  console.error(`  coderecall init --language <name>`);
  console.error(`  coderecall init --extensions ".ext1,.ext2"`);
  console.error(``);
  console.error(`Known languages: ${Object.keys(LANGUAGE_PRESETS).join(", ")}`);
  process.exit(2);
}

async function promptForLanguage(): Promise<LanguageChoice> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (p: string): Promise<string> => new Promise((res) => rl.question(p, res));

  const names = Object.keys(LANGUAGE_PRESETS);
  console.log(`No language manifest found in this project.`);
  console.log(`Pick a language to index, or enter custom extensions:\n`);
  names.forEach((name, i) => {
    const preset = LANGUAGE_PRESETS[name]!;
    console.log(`  ${(i + 1).toString().padStart(2)}) ${name.padEnd(12)} ${preset.extensions.join(", ")}`);
  });
  console.log(`  ${(names.length + 1).toString().padStart(2)}) custom       (enter extensions manually)\n`);

  const answer = (await question(`Choice [1-${names.length + 1}]: `)).trim();
  const n = parseInt(answer, 10);

  if (!isNaN(n) && n >= 1 && n <= names.length) {
    rl.close();
    const preset = LANGUAGE_PRESETS[names[n - 1]!]!;
    return { language: preset.language, extensions: preset.extensions, source: "prompt" };
  }

  if (!isNaN(n) && n === names.length + 1) {
    const raw = (await question(`Extensions (comma-separated, e.g. ".py,.pyx"): `)).trim();
    rl.close();
    const exts = parseExtensions(raw);
    if (exts.length === 0) {
      console.error(`No extensions provided. Aborting.`);
      process.exit(1);
    }
    return { language: null, extensions: exts, source: "prompt" };
  }

  rl.close();
  console.error(`Invalid choice: "${answer}". Aborting.`);
  process.exit(1);
}

function freshnessLine(f: IndexFreshness): string {
  if (f.status === "unknown") return "⚠️ Index has never been built. Run `coderecall index`.";
  if (f.status === "fresh") return "";
  const icon = f.status === "very_stale" ? "🔴" : "🟡";
  return `${icon} Index is ${f.daysOld} days old (threshold: ${f.staleAfterDays}d). Run \`coderecall index\` to refresh.`;
}

// ==================== rendering helpers ====================

function renderLegacy(results: any[]) {
  if (results.length === 0) {
    console.log("No results found.");
    return;
  }
  console.log(`Found ${results.length} results:\n`);
  for (const r of results) {
    if (r.type === "code") {
      console.log(`[CODE] ${r.filepath}:${r.start_line}-${r.end_line}`);
      console.log(`  Name: ${r.name}`);
      console.log(`  Score: ${r.score.toFixed(4)}`);
      if (r.signature) console.log(`  Signature: ${r.signature}`);
      console.log(`  Preview: ${r.content.slice(0, 100).replace(/\n/g, " ")}...`);
    } else {
      console.log(`[KNOWLEDGE] ${r.title}`);
      console.log(`  Category: ${r.category}`);
      console.log(`  Score: ${r.score.toFixed(4)}`);
      console.log(`  Tags: ${r.tags?.join(", ") || "none"}`);
      console.log(`  Preview: ${r.content.slice(0, 100).replace(/\n/g, " ")}...`);
    }
    console.log("");
  }
}

function renderTiered(results: any[]) {
  if (results.length === 0) {
    console.log("No results found.");
    return;
  }
  const fullCount = results.filter((r) => r.expansion === "full").length;
  const summaryCount = results.filter((r) => r.expansion === "summary").length;
  const metadataCount = results.filter((r) => r.expansion === "metadata").length;
  console.log(
    `Found ${results.length} results (${fullCount} full, ${summaryCount} summary, ${metadataCount} metadata-only)\n`
  );

  for (const r of results) {
    const emoji = r.confidence === "high" ? "🟢" : r.confidence === "medium" ? "🟡" : "🔴";
    if (r.type === "code") {
      console.log(`${emoji} [CODE] [${r.expansion.toUpperCase()}] ${r.filepath}:${r.start_line}-${r.end_line}`);
      console.log(`  Name: ${r.name}`);
      console.log(`  Score: ${r.score.toFixed(4)} | Confidence: ${r.confidence}`);
      if (r.signature) console.log(`  Signature: ${r.signature}`);
      if (r.expansion === "full" && r.content) {
        console.log(
          `  Content:\n${r.content.slice(0, 300).replace(/^/gm, "    ")}${r.content.length > 300 ? "..." : ""}`
        );
      } else if (r.expansion === "summary" && r.summary) {
        console.log(`  Summary: ${r.summary}`);
      }
    } else {
      console.log(`${emoji} [KNOWLEDGE] [${r.expansion.toUpperCase()}] ${r.title}`);
      console.log(`  Category: ${r.category}`);
      console.log(`  Score: ${r.score.toFixed(4)} | Confidence: ${r.confidence}`);
      console.log(`  Tags: ${r.tags?.join(", ") || "none"}`);
      if (r.expansion === "full" && r.content) {
        console.log(
          `  Content:\n${r.content.slice(0, 300).replace(/^/gm, "    ")}${r.content.length > 300 ? "..." : ""}`
        );
      } else if (r.expansion === "summary" && r.summary) {
        console.log(`  Summary: ${r.summary}`);
      }
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
