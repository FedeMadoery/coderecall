import { describe, expect, test } from "bun:test";

import { keywordScoreFromRank } from "../src/search/hybrid";
import { SelectionPolicy, type SelectionCandidate } from "../src/search/selector";
import { TOPIC_PROFILE, DEFINITION_PROFILE, profileFor, detectSearchType } from "../src/search/profiles";

function candidate(id: string, vectorScore: number, keywordScore: number, filepath?: string): SelectionCandidate {
  return { source_id: id, source_type: "code", vectorScore, keywordScore, filepath };
}

describe("keyword score from BM25 rank", () => {
  test("no match scores zero", () => {
    expect(keywordScoreFromRank(0)).toBe(0);
  });

  test("stronger BM25 always scores higher", () => {
    // The bug this replaces: dividing by the best rank in the same result set,
    // which pinned the top hit to exactly 1.0 on every query.
    const scores = [1, 5, 9, 14, 22].map((r) => keywordScoreFromRank(-r));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });

  test("is bounded, and does not saturate over the realistic BM25 range", () => {
    // Observed corpus max was |bm25| ~22; the transform must still have headroom
    // there, which is the whole point of replacing top-row normalization.
    expect(keywordScoreFromRank(-22)).toBeLessThan(0.95);
    expect(keywordScoreFromRank(-0.5)).toBeGreaterThan(0);
    // Far outside the observed range it converges to 1 in float64. Bounded is
    // the property that matters; strict inequality is not.
    expect(keywordScoreFromRank(-1000)).toBeLessThanOrEqual(1);
  });

  test("sign of the rank does not matter — FTS5 reports it negative", () => {
    expect(keywordScoreFromRank(-9)).toBeCloseTo(keywordScoreFromRank(9), 10);
  });

  test("a median-strength hit lands mid-scale, not at the top", () => {
    // Measured corpus median |bm25| was ~9.
    const median = keywordScoreFromRank(-9);
    expect(median).toBeGreaterThan(0.5);
    expect(median).toBeLessThan(0.75);
  });
});

describe("intent detection", () => {
  test("identifier-shaped queries route to definition", () => {
    expect(detectSearchType("ResumeExperienceRepository")).toBe("definition");
    expect(detectSearchType("extract_required_techs")).toBe("definition");
    expect(detectSearchType("getUserById")).toBe("definition");
    expect(detectSearchType("MemoryDatabase.saveEmbedding")).toBe("definition");
  });

  test("prose queries route to topic", () => {
    expect(detectSearchType("how does authentication work")).toBe("topic");
    expect(detectSearchType("where is the job description parsed")).toBe("topic");
    expect(detectSearchType("why did we drop the scheduler")).toBe("topic");
  });

  test("plain lowercase words are treated as prose, not identifiers", () => {
    // Misrouting a conceptual question into the lexical profile is the more
    // damaging error, so ambiguous input defaults to topic.
    expect(detectSearchType("authentication")).toBe("topic");
    expect(detectSearchType("retry logic")).toBe("topic");
  });

  test("profileFor maps intents to distinct profiles", () => {
    expect(profileFor("definition")).toBe(DEFINITION_PROFILE);
    expect(profileFor("topic")).toBe(TOPIC_PROFILE);
    expect(profileFor("auto")).toBe(TOPIC_PROFILE);
  });
});

describe("profiles", () => {
  test("leg weights sum to 1, so a score reads as a confidence", () => {
    for (const p of [TOPIC_PROFILE, DEFINITION_PROFILE]) {
      expect(p.vectorWeight + p.keywordWeight).toBeCloseTo(1, 10);
    }
  });

  test("full threshold sits above the summary threshold", () => {
    for (const p of [TOPIC_PROFILE, DEFINITION_PROFILE]) {
      expect(p.fullExpansionThreshold).toBeGreaterThan(p.summaryExpansionThreshold);
    }
  });

  test("definition demands a higher score to expand than topic", () => {
    // Calibration found definition scores separate cleanly from wrong answers,
    // so the bar can be set high; topic scores overlap and cannot.
    expect(DEFINITION_PROFILE.fullExpansionThreshold).toBeGreaterThan(TOPIC_PROFILE.fullExpansionThreshold);
  });
});

describe("selection with diversity", () => {
  const policy = new SelectionPolicy(TOPIC_PROFILE);

  test("picks the strongest candidate first", () => {
    const selected = policy.selectWithDiversity(
      [candidate("a", 0.5, 0.5, "x.ts"), candidate("b", 0.9, 0.9, "y.ts"), candidate("c", 0.7, 0.7, "z.ts")],
      3
    );
    expect(selected.map((s) => s.source_id)).toEqual(["b", "c", "a"]);
  });

  test("the diversity penalty is actually applied", () => {
    // The bug this covers: every candidate used to be scored before the
    // seen-files map was populated, so the penalty was always multiplied by
    // zero and the setting did nothing.
    //
    // Two strong candidates share a file; a third, slightly weaker one is
    // elsewhere. With a live penalty the fresh file must come second.
    const selected = policy.selectWithDiversity(
      [
        candidate("same-1", 0.9, 0.9, "crowded.ts"),
        candidate("same-2", 0.85, 0.85, "crowded.ts"),
        candidate("other", 0.8, 0.8, "elsewhere.ts")
      ],
      3
    );

    expect(selected[0]!.source_id).toBe("same-1");
    expect(selected[1]!.source_id).toBe("other");
    expect(selected[2]!.source_id).toBe("same-2");
  });

  test("the second hit from a file scores lower than it would alone", () => {
    const alone = policy.selectWithDiversity([candidate("x", 0.8, 0.8, "f.ts")], 1)[0]!;
    const crowded = policy.selectWithDiversity(
      [candidate("first", 0.9, 0.9, "f.ts"), candidate("x", 0.8, 0.8, "f.ts")],
      2
    )[1]!;

    expect(crowded.source_id).toBe("x");
    expect(crowded.finalScore).toBeLessThan(alone.finalScore);
    expect(alone.finalScore - crowded.finalScore).toBeCloseTo(TOPIC_PROFILE.diversityPenalty, 5);
  });

  test("never exceeds maxResultsPerFile from one file", () => {
    const many = Array.from({ length: 10 }, (_, i) => candidate(`c${i}`, 0.9 - i * 0.01, 0.9, "one.ts"));
    const selected = policy.selectWithDiversity(many, 10);
    expect(selected.length).toBe(TOPIC_PROFILE.maxResultsPerFile);
  });

  test("respects the requested limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => candidate(`c${i}`, 0.5, 0.5, `f${i}.ts`));
    expect(policy.selectWithDiversity(many, 5).length).toBe(5);
  });

  test("assigns tiers from the profile thresholds", () => {
    const selected = policy.selectWithDiversity(
      [candidate("hi", 0.95, 0.95, "a.ts"), candidate("mid", 0.55, 0.55, "b.ts"), candidate("lo", 0.1, 0.1, "c.ts")],
      3
    );
    const byId = Object.fromEntries(selected.map((s) => [s.source_id, s]));
    expect(byId["hi"]!.expansion).toBe("full");
    expect(byId["mid"]!.expansion).toBe("summary");
    expect(byId["lo"]!.expansion).toBe("metadata");
  });

  test("scores never go negative even under repeated penalties", () => {
    const many = Array.from({ length: 4 }, (_, i) => candidate(`c${i}`, 0.02, 0.02, "one.ts"));
    for (const s of new SelectionPolicy({ ...TOPIC_PROFILE, maxResultsPerFile: 4 }).selectWithDiversity(many, 4)) {
      expect(s.finalScore).toBeGreaterThanOrEqual(0);
    }
  });

  test("an empty candidate list yields nothing", () => {
    expect(policy.selectWithDiversity([], 5)).toEqual([]);
  });
});
