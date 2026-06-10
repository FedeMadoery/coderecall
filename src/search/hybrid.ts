import { MemoryDatabase } from "../storage/database";
import { EmbeddingManager } from "../embeddings/manager";
import type { SearchResult, TieredResult, ExpansionMode, CodeChunk, KnowledgeEntry } from "../types";
import { SelectionPolicy, type SelectionCandidate, type ScoredCandidate as TieredCandidate } from "./selector";
import { ChunkSummarizer } from "./summarizer";

interface ScoredCandidate {
  source_id: string;
  source_type: "code" | "knowledge";
  keyword_score: number;
  vector_score: number;
  combined_score: number;
}

export class HybridSearch {
  private db: MemoryDatabase;
  private embeddings: EmbeddingManager;
  private selector: SelectionPolicy;
  private summarizer: ChunkSummarizer;

  // Weights for combining scores (from HMLR design)
  private keywordWeight = 0.4;
  private vectorWeight = 0.6;

  // Thresholds for two-key approval
  private minVectorScoreForApproval = 0.3;
  private highVectorThreshold = 0.8;

  // Confidence-tiered search: expanded candidate pool multiplier
  private candidatePoolMultiplier = 5;

  constructor(db: MemoryDatabase, embeddings: EmbeddingManager) {
    this.db = db;
    this.embeddings = embeddings;
    this.selector = new SelectionPolicy();
    this.summarizer = new ChunkSummarizer();
  }

  async search(
    query: string,
    filter: "all" | "code" | "knowledge" = "all",
    limit: number = 10
  ): Promise<SearchResult[]> {
    // Get candidates from both search methods
    const keywordResults = this.keywordSearch(query, limit * 3);
    const vectorResults = await this.vectorSearch(query, limit * 3);

    // Merge and score candidates using two-key approval
    const candidates = this.mergeAndScore(keywordResults, vectorResults, filter);

    // Get full details for top results
    const results = await this.hydrateResults(candidates.slice(0, limit));

    return results;
  }

  /**
   * Confidence-tiered search.
   *
   * Pulls a wider candidate pool, scores it with keyword + vector + recency,
   * enforces per-file diversity, then returns each result at one of three
   * expansion tiers (full / summary / metadata) based on its confidence.
   */
  async tieredSearch(
    query: string,
    filter: "all" | "code" | "knowledge" = "all",
    limit: number = 10,
    expansionMode: ExpansionMode = "selective"
  ): Promise<TieredResult[]> {
    // 1. Expand candidate pool (retrieve more than needed)
    const poolSize = limit * this.candidatePoolMultiplier;
    const keywordResults = this.keywordSearch(query, poolSize);
    const vectorResults = await this.vectorSearch(query, poolSize);

    // 2. Merge candidates with metadata for selection
    const candidates = await this.prepareSelectionCandidates(keywordResults, vectorResults, filter);

    // 3. Detect query context for re-ranking
    const queryContext = this.selector.detectQueryContext(query);

    // 4. Select with diversity constraints
    let selected = this.selector.selectWithDiversity(candidates, limit);

    // 5. Re-rank based on query context
    selected = this.selector.rerank(selected, queryContext);

    // 6. Hydrate at the appropriate tier
    const results = await this.hydrateTieredResults(selected, expansionMode);

    return results;
  }

  /**
   * Prepare candidates with metadata for tiered selection
   */
  private async prepareSelectionCandidates(
    keywordResults: Map<string, { source_type: string; score: number }>,
    vectorResults: Map<string, { source_type: string; score: number }>,
    filter: "all" | "code" | "knowledge"
  ): Promise<SelectionCandidate[]> {
    const candidates: SelectionCandidate[] = [];
    const allIds = new Set([...keywordResults.keys(), ...vectorResults.keys()]);

    for (const id of allIds) {
      const keyword = keywordResults.get(id);
      const vector = vectorResults.get(id);

      const sourceType = (keyword?.source_type || vector?.source_type) as "code" | "knowledge";

      // Apply filter
      if (filter !== "all" && sourceType !== filter) continue;

      const keywordScore = keyword?.score || 0;
      const vectorScore = vector?.score || 0;

      // Get metadata for diversity and recency
      const metadata = await this.getCandidateMetadata(id, sourceType);

      candidates.push({
        source_id: id,
        source_type: sourceType,
        vectorScore,
        keywordScore,
        filepath: metadata.filepath,
        title: metadata.title,
        updatedAt: metadata.updatedAt
      });
    }

    return candidates;
  }

  /**
   * Get metadata for a candidate (for diversity and recency calculations)
   */
  private async getCandidateMetadata(
    id: string,
    sourceType: "code" | "knowledge"
  ): Promise<{ filepath?: string; title?: string; updatedAt?: string }> {
    if (sourceType === "code") {
      try {
        const db = (this.db as any).db;
        const row = db
          .prepare(
            `
          SELECT f.filepath, c.name
          FROM code_chunks c
          JOIN code_files f ON c.file_id = f.id
          WHERE c.id = ?
        `
          )
          .get(id) as any;

        return {
          filepath: row?.filepath,
          title: row?.name
        };
      } catch {
        return {};
      }
    } else {
      const knowledge = this.db.getKnowledge(id);
      return {
        title: knowledge?.title,
        updatedAt: knowledge?.updated_at
      };
    }
  }

  /**
   * Hydrate selected candidates at their assigned expansion tier.
   */
  private async hydrateTieredResults(
    candidates: TieredCandidate[],
    expansionMode: ExpansionMode
  ): Promise<TieredResult[]> {
    const results: TieredResult[] = [];

    for (const candidate of candidates) {
      // Determine effective expansion level based on mode
      let effectiveExpansion = candidate.expansion;
      if (expansionMode === "all") {
        effectiveExpansion = "full";
      } else if (expansionMode === "metadata_only") {
        effectiveExpansion = "metadata";
      }

      if (candidate.source_type === "code") {
        const result = await this.hydrateTieredCodeResult(candidate, effectiveExpansion);
        if (result) results.push(result);
      } else {
        const result = this.hydrateTieredKnowledgeResult(candidate, effectiveExpansion);
        if (result) results.push(result);
      }
    }

    return results;
  }

  /**
   * Hydrate a code result at the given expansion tier.
   */
  private async hydrateTieredCodeResult(
    candidate: TieredCandidate,
    expansion: "full" | "summary" | "metadata"
  ): Promise<TieredResult | null> {
    try {
      const db = (this.db as any).db;
      const row = db
        .prepare(
          `
        SELECT c.*, f.filepath
        FROM code_chunks c
        JOIN code_files f ON c.file_id = f.id
        WHERE c.id = ?
      `
        )
        .get(candidate.source_id) as any;

      if (!row) return null;

      const chunk: CodeChunk = {
        id: row.id,
        file_id: row.file_id,
        chunk_type: row.chunk_type,
        visibility: row.visibility ?? null,
        name: row.name,
        content: row.content,
        start_line: row.start_line,
        end_line: row.end_line,
        parent_id: row.parent_id,
        signature: row.signature,
        docstring: row.docstring
      };

      const result: TieredResult = {
        id: row.id,
        type: "code",
        score: candidate.finalScore,
        confidence: candidate.confidence,
        expansion,
        filepath: row.filepath,
        name: row.name,
        start_line: row.start_line,
        end_line: row.end_line,
        signature: row.signature
      };

      // Add content based on expansion level
      if (expansion === "full") {
        result.content = row.content;
      } else if (expansion === "summary") {
        result.summary = this.summarizer.summarizeCode(chunk);
      }

      return result;
    } catch (err) {
      console.error("Failed to hydrate tiered code result:", err);
      return null;
    }
  }

  /**
   * Hydrate a knowledge result at the given expansion tier.
   */
  private hydrateTieredKnowledgeResult(
    candidate: TieredCandidate,
    expansion: "full" | "summary" | "metadata"
  ): TieredResult | null {
    const knowledge = this.db.getKnowledge(candidate.source_id);
    if (!knowledge) return null;

    const result: TieredResult = {
      id: knowledge.id,
      type: "knowledge",
      score: candidate.finalScore,
      confidence: candidate.confidence,
      expansion,
      title: knowledge.title,
      category: knowledge.category,
      tags: knowledge.tags
    };

    // Add content based on expansion level
    if (expansion === "full") {
      result.content = knowledge.content;
    } else if (expansion === "summary") {
      result.summary = this.summarizer.summarizeKnowledge(knowledge);
    }

    return result;
  }

  private keywordSearch(query: string, limit: number): Map<string, { source_type: string; score: number }> {
    const results = new Map<string, { source_type: string; score: number }>();

    try {
      // Prepare query for FTS5 (escape special characters, add wildcards)
      const ftsQuery = this.prepareFTSQuery(query);
      const rows = this.db.searchFTS(ftsQuery, limit);

      // Normalize ranks to 0-1 scores
      const maxRank = rows.length > 0 ? Math.abs(rows[0]!.rank) : 1;

      for (const row of rows) {
        // FTS5 rank is negative, more negative = better match
        const score = maxRank > 0 ? Math.abs(row.rank) / maxRank : 0;
        results.set(row.source_id, {
          source_type: row.source_type,
          score: Math.min(1, score)
        });
      }
    } catch (err) {
      console.warn("FTS search failed:", err);
    }

    return results;
  }

  private prepareFTSQuery(query: string): string {
    // Split into words and create OR query with prefix matching
    const words = query
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    if (words.length === 0) return query;

    // Use prefix matching for flexibility
    return words.map((w) => `${w}*`).join(" OR ");
  }

  private async vectorSearch(
    query: string,
    limit: number
  ): Promise<Map<string, { source_type: string; score: number }>> {
    const results = new Map<string, { source_type: string; score: number }>();

    try {
      // Get query embedding
      const queryVector = await this.embeddings.embed(query);

      // Get all embeddings from database
      const allEmbeddings = this.db.getAllEmbeddings();

      // Calculate similarities
      const scored = allEmbeddings.map((emb) => ({
        source_id: emb.source_id,
        source_type: emb.source_type,
        score: EmbeddingManager.cosineSimilarity(queryVector, emb.vector)
      }));

      // Sort by score and take top results
      scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .forEach((item) => {
          results.set(item.source_id, {
            source_type: item.source_type,
            score: item.score
          });
        });
    } catch (err) {
      console.warn("Vector search failed:", err);
    }

    return results;
  }

  private mergeAndScore(
    keywordResults: Map<string, { source_type: string; score: number }>,
    vectorResults: Map<string, { source_type: string; score: number }>,
    filter: "all" | "code" | "knowledge"
  ): ScoredCandidate[] {
    const candidates = new Map<string, ScoredCandidate>();

    // Process all unique IDs
    const allIds = new Set([...keywordResults.keys(), ...vectorResults.keys()]);

    for (const id of allIds) {
      const keyword = keywordResults.get(id);
      const vector = vectorResults.get(id);

      // Determine source type
      const sourceType = (keyword?.source_type || vector?.source_type) as "code" | "knowledge";

      // Apply filter
      if (filter !== "all" && sourceType !== filter) continue;

      const keywordScore = keyword?.score || 0;
      const vectorScore = vector?.score || 0;

      // Two-key approval logic (from HMLR):
      // Option A: Has keyword match + vector match → weighted score
      // Option B: High vector only (>0.8) → slight penalty
      let combinedScore: number;
      let approved = false;

      if (keywordScore > 0 && vectorScore >= this.minVectorScoreForApproval) {
        // Option A: Both signals present
        combinedScore = keywordScore * this.keywordWeight + vectorScore * this.vectorWeight;
        approved = true;
      } else if (vectorScore >= this.highVectorThreshold) {
        // Option B: High vector score alone (penalized slightly)
        combinedScore = vectorScore * 0.85;
        approved = true;
      } else if (keywordScore > 0.5) {
        // Strong keyword match only (lower confidence)
        combinedScore = keywordScore * 0.7;
        approved = true;
      }

      if (approved) {
        candidates.set(id, {
          source_id: id,
          source_type: sourceType,
          keyword_score: keywordScore,
          vector_score: vectorScore,
          combined_score: combinedScore!
        });
      }
    }

    // Sort by combined score
    return Array.from(candidates.values()).sort((a, b) => b.combined_score - a.combined_score);
  }

  private async hydrateResults(candidates: ScoredCandidate[]): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const candidate of candidates) {
      if (candidate.source_type === "code") {
        const result = await this.hydrateCodeResult(candidate);
        if (result) results.push(result);
      } else {
        const result = this.hydrateKnowledgeResult(candidate);
        if (result) results.push(result);
      }
    }

    return results;
  }

  private async hydrateCodeResult(candidate: ScoredCandidate): Promise<SearchResult | null> {
    // Get chunk details
    const chunks = this.db.getAllEmbeddings().filter((e) => e.source_id === candidate.source_id);

    if (chunks.length === 0) return null;

    // Query the chunk directly
    const stmt = `
      SELECT c.*, f.filepath
      FROM code_chunks c
      JOIN code_files f ON c.file_id = f.id
      WHERE c.id = ?
    `;

    // We need to add this query to the database class, for now use raw approach
    try {
      const db = (this.db as any).db;
      const row = db.prepare(stmt).get(candidate.source_id) as any;

      if (!row) return null;

      return {
        type: "code",
        id: row.id,
        score: candidate.combined_score,
        filepath: row.filepath,
        name: row.name,
        start_line: row.start_line,
        end_line: row.end_line,
        signature: row.signature,
        content: row.content
      };
    } catch (err) {
      console.error("Failed to hydrate code result:", err);
      return null;
    }
  }

  private hydrateKnowledgeResult(candidate: ScoredCandidate): SearchResult | null {
    const knowledge = this.db.getKnowledge(candidate.source_id);
    if (!knowledge) return null;

    return {
      type: "knowledge",
      id: knowledge.id,
      score: candidate.combined_score,
      title: knowledge.title,
      category: knowledge.category,
      tags: knowledge.tags,
      content: knowledge.content
    };
  }
}
