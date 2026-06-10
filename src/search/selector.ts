/**
 * Selection Policy Module
 *
 * Implements confidence-tiered expansion based on multi-signal scoring:
 * candidates are scored, deduplicated for diversity, and each is tagged
 * with a confidence band (high/medium/low) that determines whether it is
 * returned as full content, summary, or metadata-only.
 */

export interface SelectionCandidate {
  source_id: string;
  source_type: "code" | "knowledge";
  vectorScore: number;
  keywordScore: number;
  filepath?: string;
  title?: string;
  updatedAt?: string;
}

export interface ScoredCandidate extends SelectionCandidate {
  finalScore: number;
  confidence: "high" | "medium" | "low";
  expansion: "full" | "summary" | "metadata";
}

export interface SelectionConfig {
  // Weight factors for scoring
  vectorWeight: number;
  keywordWeight: number;
  recencyWeight: number;
  diversityPenalty: number;

  // Thresholds for expansion levels
  fullExpansionThreshold: number;
  summaryExpansionThreshold: number;

  // Diversity constraints
  maxResultsPerFile: number;
}

const DEFAULT_CONFIG: SelectionConfig = {
  vectorWeight: 0.5,
  keywordWeight: 0.3,
  recencyWeight: 0.2,
  diversityPenalty: 0.15,

  fullExpansionThreshold: 0.7,
  summaryExpansionThreshold: 0.4,

  maxResultsPerFile: 3
};

export class SelectionPolicy {
  private config: SelectionConfig;

  constructor(config: Partial<SelectionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Score a candidate using multiple signals
   */
  score(candidate: SelectionCandidate, seenFilepaths: Map<string, number>): number {
    const { vectorWeight, keywordWeight, recencyWeight, diversityPenalty } = this.config;

    // Base score from vector and keyword similarity
    const baseScore = candidate.vectorScore * vectorWeight + candidate.keywordScore * keywordWeight;

    // Recency boost (if available)
    const recencyBoost = this.calculateRecencyBoost(candidate.updatedAt) * recencyWeight;

    // Diversity penalty for clustering
    const filepath = candidate.filepath || candidate.title || "unknown";
    const fileCount = seenFilepaths.get(filepath) || 0;
    const diversityPenaltyValue = fileCount * diversityPenalty;

    return Math.max(0, baseScore + recencyBoost - diversityPenaltyValue);
  }

  /**
   * Calculate recency boost based on last update time
   * Returns 0-1 where 1 = updated within last day
   */
  private calculateRecencyBoost(updatedAt?: string): number {
    if (!updatedAt) return 0.5; // Default boost for unknown

    try {
      const updated = new Date(updatedAt);
      const now = new Date();
      const daysSinceUpdate = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24);

      // Exponential decay: recent updates get higher boost
      // 0 days = 1.0, 7 days = 0.5, 30 days = 0.2, 90+ days = ~0
      return Math.exp(-daysSinceUpdate / 30);
    } catch {
      return 0.5;
    }
  }

  /**
   * Determine expansion level based on score
   */
  getExpansionLevel(score: number): "full" | "summary" | "metadata" {
    if (score >= this.config.fullExpansionThreshold) {
      return "full";
    } else if (score >= this.config.summaryExpansionThreshold) {
      return "summary";
    }
    return "metadata";
  }

  /**
   * Determine confidence level based on score
   */
  getConfidence(score: number): "high" | "medium" | "low" {
    if (score >= 0.7) return "high";
    if (score >= 0.4) return "medium";
    return "low";
  }

  /**
   * Select top-N candidates with diversity constraints
   */
  selectWithDiversity(candidates: SelectionCandidate[], limit: number): ScoredCandidate[] {
    const seenFilepaths = new Map<string, number>();
    const selected: ScoredCandidate[] = [];

    // Score all candidates
    const scored = candidates.map((candidate) => ({
      ...candidate,
      finalScore: this.score(candidate, seenFilepaths)
    }));

    // Sort by score descending
    scored.sort((a, b) => b.finalScore - a.finalScore);

    // Select with diversity constraint
    for (const candidate of scored) {
      const filepath = candidate.filepath || candidate.title || "unknown";
      const fileCount = seenFilepaths.get(filepath) || 0;

      // Check diversity constraint
      if (fileCount >= this.config.maxResultsPerFile) {
        // Re-score with penalty already applied, skip if too many from same file
        continue;
      }

      // Add to selection
      const confidence = this.getConfidence(candidate.finalScore);
      const expansion = this.getExpansionLevel(candidate.finalScore);

      selected.push({
        ...candidate,
        confidence,
        expansion
      });

      // Track filepath count
      seenFilepaths.set(filepath, fileCount + 1);

      if (selected.length >= limit) break;
    }

    return selected;
  }

  /**
   * Re-rank candidates after initial selection
   * Useful for adjusting based on query context
   */
  rerank(
    candidates: ScoredCandidate[],
    queryContext: { isCodeQuery: boolean; isArchitectureQuery: boolean }
  ): ScoredCandidate[] {
    return candidates.map((candidate) => {
      let boost = 0;

      // Boost code results for code-related queries
      if (queryContext.isCodeQuery && candidate.source_type === "code") {
        boost += 0.1;
      }

      // Boost knowledge results for architecture queries
      if (queryContext.isArchitectureQuery && candidate.source_type === "knowledge") {
        boost += 0.1;
      }

      const newScore = Math.min(1, candidate.finalScore + boost);

      return {
        ...candidate,
        finalScore: newScore,
        confidence: this.getConfidence(newScore),
        expansion: this.getExpansionLevel(newScore)
      };
    });
  }

  /**
   * Detect query context for re-ranking
   */
  detectQueryContext(query: string): { isCodeQuery: boolean; isArchitectureQuery: boolean } {
    const lowerQuery = query.toLowerCase();

    const codePatterns = [
      /\bfunction\b/,
      /\bdef\b/,
      /\bmodule\b/,
      /\bimpl/,
      /\bcode\b/,
      /\bhow\s+(?:does|do|is)\b.*\bwork/,
      /\bcall/,
      /\breturn/,
      /\bparameter/,
      /\bargument/
    ];

    const architecturePatterns = [
      /\barchitecture\b/,
      /\bdesign\b/,
      /\bpattern\b/,
      /\bwhy\b/,
      /\bdecision\b/,
      /\bapproach\b/,
      /\bstructure\b/,
      /\boverview\b/
    ];

    const isCodeQuery = codePatterns.some((p) => p.test(lowerQuery));
    const isArchitectureQuery = architecturePatterns.some((p) => p.test(lowerQuery));

    return { isCodeQuery, isArchitectureQuery };
  }
}
