/**
 * Selection Policy Module
 *
 * Scores candidates, selects them with a live diversity constraint, and tags
 * each with a confidence band that decides whether it comes back as full
 * content, a summary, or metadata only.
 *
 * Scoring is `vector * vw + keyword * kw - diversity`, with the two weights
 * summing to 1 so a score reads as a confidence in [0, 1].
 *
 * Recency is deliberately absent. It used to contribute up to 0.2, but only
 * knowledge entries had a usable timestamp; code chunks fell through to a
 * hardcoded 0.5 default and took a flat +0.1 regardless of age. The result was
 * not a recency signal at all, just a standing bonus for knowledge entries —
 * which is why they won the top slot on code-shaped queries. `code_files
 * .indexed_at` cannot replace it either: it records when indexing ran, so it
 * is identical for every file in a full reindex.
 */
import type { RetrievalProfile } from "./profiles";
import { TOPIC_PROFILE } from "./profiles";

export interface SelectionCandidate {
  source_id: string;
  source_type: "code" | "knowledge";
  vectorScore: number;
  keywordScore: number;
  filepath?: string;
  title?: string;
}

export interface ScoredCandidate extends SelectionCandidate {
  finalScore: number;
  confidence: "high" | "medium" | "low";
  expansion: "full" | "summary" | "metadata";
}

export class SelectionPolicy {
  private profile: RetrievalProfile;

  constructor(profile: RetrievalProfile = TOPIC_PROFILE) {
    this.profile = profile;
  }

  getProfile(): RetrievalProfile {
    return this.profile;
  }

  /** Group key for diversity: the file for code, the entry itself for knowledge. */
  private groupKey(candidate: SelectionCandidate): string {
    return candidate.filepath || candidate.title || "unknown";
  }

  /**
   * Base relevance, before any diversity adjustment.
   */
  baseScore(candidate: SelectionCandidate): number {
    const { vectorWeight, keywordWeight } = this.profile;
    return candidate.vectorScore * vectorWeight + candidate.keywordScore * keywordWeight;
  }

  /**
   * Relevance with the diversity penalty for what has already been picked.
   */
  score(candidate: SelectionCandidate, seenGroups: Map<string, number>): number {
    const alreadyPicked = seenGroups.get(this.groupKey(candidate)) || 0;
    return Math.max(0, this.baseScore(candidate) - alreadyPicked * this.profile.diversityPenalty);
  }

  getExpansionLevel(score: number): "full" | "summary" | "metadata" {
    if (score >= this.profile.fullExpansionThreshold) return "full";
    if (score >= this.profile.summaryExpansionThreshold) return "summary";
    return "metadata";
  }

  getConfidence(score: number): "high" | "medium" | "low" {
    if (score >= this.profile.fullExpansionThreshold) return "high";
    if (score >= this.profile.summaryExpansionThreshold) return "medium";
    return "low";
  }

  /**
   * Greedily select the best remaining candidate, then re-score the rest.
   *
   * The re-scoring is the point: the previous implementation scored every
   * candidate up front, while the map tracking per-file counts was still empty,
   * so the diversity penalty was always multiplied by zero and the setting did
   * nothing. Diversity came solely from the hard per-file cap. Selecting
   * incrementally makes the penalty real — a second chunk from an
   * already-represented file now has to actually outscore a fresh file.
   */
  selectWithDiversity(candidates: SelectionCandidate[], limit: number): ScoredCandidate[] {
    const seenGroups = new Map<string, number>();
    const selected: ScoredCandidate[] = [];
    const remaining = [...candidates];

    while (selected.length < limit && remaining.length > 0) {
      let bestIndex = -1;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]!;
        const key = this.groupKey(candidate);
        if ((seenGroups.get(key) || 0) >= this.profile.maxResultsPerFile) continue;

        const score = this.score(candidate, seenGroups);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex === -1) break; // everything left is capped out

      const [winner] = remaining.splice(bestIndex, 1) as [SelectionCandidate];
      const key = this.groupKey(winner);
      seenGroups.set(key, (seenGroups.get(key) || 0) + 1);

      selected.push({
        ...winner,
        finalScore: bestScore,
        confidence: this.getConfidence(bestScore),
        expansion: this.getExpansionLevel(bestScore)
      });
    }

    return selected;
  }
}
