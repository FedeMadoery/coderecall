import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "path";

import { MemoryDatabase } from "../storage/database";
import { EmbeddingManager } from "../embeddings/manager";
import { HybridSearch } from "../search/hybrid";
import { CodeChunker } from "../indexer/chunker";
import { FileScanner } from "../indexer/scanner";
import type { ExpansionMode, IndexFreshness, TieredResult } from "../types";
import type { CoderecallConfig } from "../config";

function freshnessBanner(f: IndexFreshness): string {
  if (f.status === "unknown") {
    return `⚠️ Index has never been built. Run \`coderecall index\` before searching.`;
  }
  if (f.status === "fresh") return "";
  const icon = f.status === "very_stale" ? "🔴" : "🟡";
  return `${icon} Index is ${f.daysOld} days old (threshold: ${f.staleAfterDays}d). Consider \`coderecall index\` to refresh.`;
}

function withBanner(banner: string, body: string): string {
  return banner ? `${banner}\n\n${body}` : body;
}

export class CoderecallServer {
  private mcpServer: McpServer;
  private db: MemoryDatabase;
  private embeddings: EmbeddingManager;
  private search: HybridSearch;
  private chunker: CodeChunker;
  private config: CoderecallConfig;

  constructor(dbPath: string, config: CoderecallConfig) {
    this.config = config;
    this.db = new MemoryDatabase(dbPath);
    this.embeddings = new EmbeddingManager(config.embeddingModel);
    this.search = new HybridSearch(this.db, this.embeddings);
    this.chunker = new CodeChunker(this.db, this.embeddings);

    this.mcpServer = new McpServer({
      name: "coderecall",
      version: "0.1.0"
    });

    this.registerTools();
  }

  private registerTools() {
    this.mcpServer.registerTool(
      "search_memory",
      {
        description:
          "Search code and knowledge using natural language. Returns relevant code snippets and knowledge entries.",
        inputSchema: {
          query: z.string().describe("Natural language search query"),
          filter: z.enum(["all", "code", "knowledge"]).default("all").describe("Filter results by type"),
          limit: z.number().default(10).describe("Maximum number of results")
        }
      },
      async (args) => {
        const { query, filter = "all", limit = 10 } = args;
        const results = await this.search.search(query, filter, limit);

        const formatted = results.map((r) => {
          if (r.type === "code") {
            return `[CODE] ${r.filepath}:${r.start_line}-${r.end_line} (${r.name})\nScore: ${r.score.toFixed(3)}\n${r.signature || ""}\n\`\`\`\n${r.content.slice(0, 500)}${r.content.length > 500 ? "..." : ""}\n\`\`\``;
          } else {
            return `[KNOWLEDGE] ${r.title} (${r.category})\nScore: ${r.score.toFixed(3)}\nTags: ${r.tags?.join(", ") || "none"}\n${r.content.slice(0, 500)}${r.content.length > 500 ? "..." : ""}`;
          }
        });

        const body =
          results.length > 0
            ? `Found ${results.length} results:\n\n${formatted.join("\n\n---\n\n")}`
            : "No results found.";

        return {
          content: [{ type: "text" as const, text: withBanner(freshnessBanner(this.freshness()), body) }]
        };
      }
    );

    this.mcpServer.registerTool(
      "search",
      {
        description:
          "Search code and knowledge with confidence-tiered expansion. Returns each result at one of three tiers (full content / summary / metadata-only) based on how confident the ranker is about it — so high-signal hits get full context and low-signal hits stay cheap.",
        inputSchema: {
          query: z.string().describe("Natural language search query"),
          filter: z.enum(["all", "code", "knowledge"]).default("all").describe("Filter results by type"),
          limit: z.number().default(10).describe("Maximum number of results"),
          expansion_mode: z
            .enum(["all", "selective", "metadata_only"])
            .default("selective")
            .describe(
              "Expansion mode: 'all' (full content), 'selective' (tiered by confidence), 'metadata_only' (minimal)"
            )
        }
      },
      async (args) => {
        const { query, filter = "all", limit = 10, expansion_mode = "selective" } = args;
        const results = await this.search.tieredSearch(query, filter, limit, expansion_mode as ExpansionMode);

        const formatted = results.map((r) => this.formatTieredResult(r));

        const fullCount = results.filter((r) => r.expansion === "full").length;
        const summaryCount = results.filter((r) => r.expansion === "summary").length;
        const metadataCount = results.filter((r) => r.expansion === "metadata").length;

        const summary = `Found ${results.length} results (${fullCount} full, ${summaryCount} summary, ${metadataCount} metadata-only)`;
        const body = results.length > 0 ? `${summary}\n\n${formatted.join("\n\n---\n\n")}` : "No results found.";

        return {
          content: [{ type: "text" as const, text: withBanner(freshnessBanner(this.freshness()), body) }]
        };
      }
    );

    this.mcpServer.registerTool(
      "add_knowledge",
      {
        description: "Store a knowledge entry (architecture decisions, patterns, notes, troubleshooting)",
        inputSchema: {
          title: z.string().describe("Title of the knowledge entry"),
          content: z.string().describe("The knowledge content"),
          category: z
            .enum(["architecture", "decision", "pattern", "note", "troubleshooting"])
            .describe("Category of the knowledge"),
          tags: z.array(z.string()).optional().describe("Tags for filtering")
        }
      },
      async (args) => {
        const { title, content, category, tags = [] } = args;

        const entry = this.db.addKnowledge({ title, content, category, tags });

        const vector = await this.embeddings.embed(`${title}\n${content}`);
        this.db.saveEmbedding("knowledge", entry.id, vector, this.embeddings.getModelName());

        this.db.indexForFTS(entry.id, "knowledge", title, content);

        return {
          content: [
            {
              type: "text" as const,
              text: `Knowledge entry created:\nID: ${entry.id}\nTitle: ${entry.title}\nCategory: ${entry.category}\nTags: ${entry.tags.join(", ")}`
            }
          ]
        };
      }
    );

    this.mcpServer.registerTool(
      "list_knowledge",
      {
        description: "List stored knowledge entries",
        inputSchema: {
          category: z
            .enum(["architecture", "decision", "pattern", "note", "troubleshooting"])
            .optional()
            .describe("Filter by category"),
          tag: z.string().optional().describe("Filter by tag")
        }
      },
      async (args) => {
        const { category, tag } = args;
        const entries = this.db.listKnowledge(category, tag);

        if (entries.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No knowledge entries found." }]
          };
        }

        const formatted = entries.map(
          (e) =>
            `- [${e.category}] ${e.title}\n  ID: ${e.id}\n  Tags: ${e.tags.join(", ") || "none"}\n  Created: ${e.created_at}`
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${entries.length} knowledge entries:\n\n${formatted.join("\n\n")}`
            }
          ]
        };
      }
    );

    this.mcpServer.registerTool(
      "index_files",
      {
        description:
          "Index files or directories for semantic search. Defaults to the extensions configured in .coderecall.json (or auto-detected for the project's language).",
        inputSchema: {
          paths: z.array(z.string()).describe("File or directory paths to index"),
          extensions: z
            .array(z.string())
            .optional()
            .describe("File extensions to include (defaults to project config)"),
          prune: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "Also drop index entries for files that no longer exist (deleted/renamed). Only applied when the path is the project root, since pruning a partial scan would delete the rest of the index."
            )
        }
      },
      async (args) => {
        const { paths, extensions, prune = false } = args;
        const exts = extensions ?? this.config.extensions;

        let totalFiles = 0;
        let totalChunks = 0;
        let totalTime = 0;
        let totalPruned = 0;
        const prunedPaths: string[] = [];
        let pruneSkipped = false;

        for (const basePath of paths) {
          const scanner = new FileScanner(basePath, { extensions: exts, ignore: this.config.ignore });
          const files = await scanner.scanAll();

          // Pruning compares the scan against the whole index, so it is only
          // sound when this scan covers the whole project.
          const isProjectRoot = resolve(basePath) === resolve(this.config.projectRoot);
          const pruneThisPath = prune && isProjectRoot;
          if (prune && !isProjectRoot) pruneSkipped = true;

          const result = await this.chunker.indexFiles(files, { prune: pruneThisPath });

          totalFiles += result.files_indexed;
          totalChunks += result.chunks_created;
          totalTime += result.time_ms;
          totalPruned += result.files_pruned;
          prunedPaths.push(...result.pruned_paths);
        }

        const lines = [
          `Indexing complete:`,
          `- Files indexed: ${totalFiles}`,
          `- Chunks created: ${totalChunks}`,
          `- Time: ${totalTime}ms`,
          `- Extensions: ${exts.join(", ")}`
        ];
        if (prune) {
          lines.push(`- Files pruned: ${totalPruned}`);
          if (prunedPaths.length > 0) {
            lines.push(...prunedPaths.slice(0, 20).map((p) => `    - ${p}`));
            if (prunedPaths.length > 20) lines.push(`    ... and ${prunedPaths.length - 20} more`);
          }
          if (pruneSkipped) {
            lines.push(
              `- Note: prune was requested but skipped for paths outside the project root (${this.config.projectRoot}).`
            );
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }]
        };
      }
    );

    this.mcpServer.registerTool(
      "index_diff",
      {
        description: "Index only changed files from git diff (for CI/CD or incremental updates)",
        inputSchema: {
          repo_path: z.string().describe("Path to the repository"),
          base_ref: z.string().default("HEAD~1").describe("Base git ref"),
          head_ref: z.string().default("HEAD").describe("Head git ref")
        }
      },
      async (args) => {
        const { repo_path, base_ref = "HEAD~1", head_ref = "HEAD" } = args;

        const result = await this.chunker.indexDiff(repo_path, base_ref, head_ref, {
          extensions: this.config.extensions,
          ignore: this.config.ignore
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Incremental indexing complete:\n- Added: ${result.added}\n- Modified: ${result.modified}\n- Deleted: ${result.deleted}\n- Time: ${result.time_ms}ms`
            }
          ]
        };
      }
    );

    this.mcpServer.registerTool(
      "get_file_context",
      {
        description: "Get all functions/modules/classes in a specific file",
        inputSchema: {
          filepath: z.string().describe("Path to the file")
        }
      },
      async (args) => {
        const { filepath } = args;

        const file = this.db.getCodeFile(filepath);
        if (!file) {
          return {
            content: [{ type: "text" as const, text: `File not found in index: ${filepath}` }]
          };
        }

        const chunks = this.db.getChunksForFile(file.id);

        const formatted = chunks.map(
          (c) =>
            `[${c.chunk_type}${c.visibility ? ` ${c.visibility}` : ""}] ${c.name} (lines ${c.start_line}-${c.end_line})\n  ${c.signature || ""}\n  ${c.docstring ? `Doc: ${c.docstring.slice(0, 100)}...` : ""}`
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `File: ${filepath}\nChunks: ${chunks.length}\n\n${formatted.join("\n\n")}`
            }
          ]
        };
      }
    );

    this.mcpServer.registerTool(
      "get_index_stats",
      {
        description: "Get statistics about the indexed content",
        inputSchema: {}
      },
      async () => {
        const stats = this.db.getStats();
        const f = this.freshness();
        const ageLine =
          f.status === "unknown"
            ? "- Index age: never indexed"
            : `- Index age: ${f.daysOld} days (status: ${f.status}; thresholds ${f.staleAfterDays}d / ${f.veryStaleAfterDays}d)`;

        const body = `Index Statistics:\n- Total files: ${stats.total_files}\n- Total chunks: ${stats.total_chunks}\n- Total knowledge entries: ${stats.total_knowledge}\n- Total embeddings: ${stats.total_embeddings}\n- Last indexed: ${stats.last_indexed || "Never"}\n- Last index run: ${f.lastIndexRun || "Never"}\n${ageLine}\n- Project root: ${this.config.projectRoot}\n- Extensions: ${this.config.extensions.join(", ")}`;

        return {
          content: [{ type: "text" as const, text: withBanner(freshnessBanner(f), body) }]
        };
      }
    );
  }

  private freshness(): IndexFreshness {
    return this.db.getIndexAge(this.config.staleAfterDays, this.config.veryStaleAfterDays);
  }

  private formatTieredResult(r: TieredResult): string {
    const confidenceEmoji = r.confidence === "high" ? "🟢" : r.confidence === "medium" ? "🟡" : "🔴";
    const expansionLabel = `[${r.expansion.toUpperCase()}]`;

    if (r.type === "code") {
      const header = `${confidenceEmoji} [CODE] ${expansionLabel} ${r.filepath}:${r.start_line}-${r.end_line} (${r.name})`;
      const score = `Score: ${r.score.toFixed(3)} | Confidence: ${r.confidence}`;
      const signature = r.signature ? `Signature: ${r.signature}` : "";

      if (r.expansion === "full" && r.content) {
        return `${header}\n${score}\n${signature}\n\`\`\`\n${r.content.slice(0, 800)}${r.content.length > 800 ? "..." : ""}\n\`\`\``;
      } else if (r.expansion === "summary" && r.summary) {
        return `${header}\n${score}\n${signature}\nSummary: ${r.summary}`;
      } else {
        return `${header}\n${score}\n${signature}`;
      }
    } else {
      const header = `${confidenceEmoji} [KNOWLEDGE] ${expansionLabel} ${r.title} (${r.category})`;
      const score = `Score: ${r.score.toFixed(3)} | Confidence: ${r.confidence}`;
      const tags = `Tags: ${r.tags?.join(", ") || "none"}`;

      if (r.expansion === "full" && r.content) {
        return `${header}\n${score}\n${tags}\n${r.content.slice(0, 800)}${r.content.length > 800 ? "..." : ""}`;
      } else if (r.expansion === "summary" && r.summary) {
        return `${header}\n${score}\n${tags}\nSummary: ${r.summary}`;
      } else {
        return `${header}\n${score}\n${tags}`;
      }
    }
  }

  async run() {
    await this.embeddings.init();

    // Fail loudly on a model/width mismatch. Left unchecked, cosineSimilarity
    // throws inside vectorSearch, the error is swallowed, and every search
    // silently degrades to keyword-only for the life of the server.
    const compat = this.db.checkEmbeddingCompatibility(this.embeddings.getModelName(), this.embeddings.getDimension());
    if (!compat.ok) {
      console.error(`⚠️  Embedding model mismatch: ${compat.reason}`);
    }

    const warm = this.db.warmEmbeddingsCache();
    if (warm.loaded > 0) {
      const mb = (warm.bytes / (1024 * 1024)).toFixed(1);
      console.error(`Loaded ${warm.loaded} embeddings into memory (${mb} MB)`);
    }

    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
    console.error("coderecall MCP server running on stdio");
  }

  close() {
    this.db.close();
  }
}
