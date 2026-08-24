/**
 * Retrieval profiles — one per query intent.
 *
 * The agent (or a heuristic) picks an intent *before* retrieval, and the
 * profile decides how wide to search, how to weigh the two legs, and how
 * readily to spend context on full expansion. A symbol lookup and a "how does
 * X work" question want genuinely different retrieval, and previously both got
 * the same treatment plus a ±0.1 nudge after the fact.
 */

export type SearchType = "auto" | "definition" | "topic";

export interface RetrievalProfile {
  name: string;
  /** Weight on cosine similarity. vectorWeight + keywordWeight must be 1. */
  vectorWeight: number;
  /** Weight on the keyword (BM25) leg. */
  keywordWeight: number;
  /** Score subtracted per already-selected result from the same file. */
  diversityPenalty: number;
  /** Hard cap on results from one file. */
  maxResultsPerFile: number;
  /** Score at or above which a result is returned as full content. */
  fullExpansionThreshold: number;
  /** Score at or above which a result is returned as a summary. */
  summaryExpansionThreshold: number;
  /** Candidate pool size as a multiple of the requested limit. */
  poolMultiplier: number;
}

/**
 * Thresholds are fitted to the labelled fixture rather than chosen as round
 * numbers: for each intent, scores of correct and incorrect results were swept
 * to trade precision against coverage.
 *
 * The two intents came out genuinely different, which is the main argument for
 * having profiles at all:
 *
 * - `definition` separates cleanly. Correct results sit at 0.81-0.85 (the exact
 *   name boost puts them there) while the highest-scoring wrong result reaches
 *   0.757, so a threshold at 0.78 captures essentially every right answer at
 *   near-perfect precision.
 * - `topic` does not separate. Correct results run p10 0.531 / p50 0.646 and
 *   wrong ones p50 0.584 / p90 0.652 — overlapping ranges. No threshold gets
 *   both precision and coverage, so this profile deliberately expands few
 *   results at higher precision and lets the summary tier carry the rest.
 *
 * Caveat: fitted on the same 30-query fixture used to score, with no held-out
 * split, so these are optimistic. Widening the fixture and refitting is the
 * honest next step. They are also **not portable across embedding models** —
 * a model whose scores run lower will expand less often.
 */
export const TOPIC_PROFILE: RetrievalProfile = {
  name: "topic",
  // Conceptual questions rarely share vocabulary with the code that answers
  // them, so lean on the vector leg.
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  diversityPenalty: 0.08,
  maxResultsPerFile: 3,
  // 0.68 buys ~71% precision at ~34% coverage. Lowering it to 0.60 would reach
  // 80% coverage but drop precision to 34% — i.e. spend most of the context
  // budget on wrong answers, which is the failure this feature exists to avoid.
  fullExpansionThreshold: 0.68,
  summaryExpansionThreshold: 0.5,
  poolMultiplier: 5
};

export const DEFINITION_PROFILE: RetrievalProfile = {
  name: "definition",
  // The user typed an identifier. Lexical match is the strong signal here and
  // the vector leg mostly supplies near-miss candidates.
  vectorWeight: 0.45,
  keywordWeight: 0.55,
  // Overloads and a class plus its methods legitimately cluster in one file,
  // so penalise clustering only lightly.
  diversityPenalty: 0.04,
  maxResultsPerFile: 4,
  // Sits in the gap between the best wrong result (0.757) and the weakest
  // correct one (0.814).
  fullExpansionThreshold: 0.78,
  summaryExpansionThreshold: 0.55,
  poolMultiplier: 3
};

export function profileFor(searchType: SearchType): RetrievalProfile {
  return searchType === "definition" ? DEFINITION_PROFILE : TOPIC_PROFILE;
}

/**
 * Guess the intent when the caller did not state one.
 *
 * Deliberately conservative: it only claims `definition` when the query looks
 * like an identifier rather than a sentence, because misrouting a conceptual
 * question into the lexical profile is the more damaging mistake.
 */
export function detectSearchType(query: string): Exclude<SearchType, "auto"> {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);

  if (words.length > 3) return "topic";

  // camelCase, PascalCase, snake_case, kebab-case, or dotted/scoped paths —
  // shapes that occur in code and essentially never in prose.
  const identifierish = /^[A-Za-z_$][\w$]*(?:[._-][\w$]+)*$/;
  const hasCodeShape = words.every(
    (w) => identifierish.test(w) && (/[_$]/.test(w) || /[a-z][A-Z]/.test(w) || /^[A-Z]/.test(w))
  );

  return hasCodeShape ? "definition" : "topic";
}
