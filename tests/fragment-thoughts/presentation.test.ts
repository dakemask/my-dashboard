import { describe, expect, it } from "vitest";
import {
  findMatchRanges,
  projectFragmentThoughts,
} from "../../src/fragment-thoughts/app/presentation";
import type {
  FragmentThought,
  FragmentThoughtsPayload,
  FragmentThoughtVersion,
} from "../../src/fragment-thoughts/domain";

const THOUGHT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THOUGHT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THOUGHT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function version(
  idStart: string,
  content: string,
  createdAt: string,
): FragmentThoughtVersion {
  return {
    id: `${idStart.repeat(8)}-${idStart.repeat(4)}-4${idStart.repeat(3)}-8${idStart.repeat(3)}-${idStart.repeat(12)}`,
    content,
    createdAt,
  };
}

function thought(
  id: string,
  versions: readonly FragmentThoughtVersion[],
  collapsedVersionIds: readonly string[] = [],
): FragmentThought {
  return { id, versions, collapsedVersionIds };
}

const A_OLD = version("1", "alpha old and ALPHA again", "2026-08-01T01:00:00.000Z");
const A_CURRENT = version("2", "Current Alpha", "2026-08-01T03:00:00.000Z");
const B_OLD = version("3", "history has alpha", "2026-08-01T01:30:00.000Z");
const B_CURRENT = version("4", "current is unrelated", "2026-08-01T04:00:00.000Z");
const C_CURRENT = version("5", "nothing here", "2026-08-01T03:00:00.000Z");

function fixture(): FragmentThoughtsPayload {
  return {
    thoughts: [
      thought(THOUGHT_C, [C_CURRENT]),
      thought(THOUGHT_B, [B_OLD, B_CURRENT], [B_OLD.id]),
      thought(THOUGHT_A, [A_OLD, A_CURRENT], [A_OLD.id]),
    ],
  };
}

describe("Fragment Thoughts search presentation", () => {
  it("uses one Unicode-aware range finder for matching and highlighting", () => {
    expect(findMatchRanges("Ää x Ä", " ä ")).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
    expect(findMatchRanges("a+b A+B", "a+b")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    expect(findMatchRanges("anything", "   ")).toEqual([]);
  });

  it("sorts by latest time descending with an id tie-breaker", () => {
    const presentation = projectFragmentThoughts(fixture(), {
      query: "",
      selectedHistoryId: null,
    });
    expect(presentation.thoughts.map((item) => item.thought.id)).toEqual([
      THOUGHT_B,
      THOUGHT_A,
      THOUGHT_C,
    ]);
  });

  it("counts current occurrences and matching historical versions from the same ranges", () => {
    const presentation = projectFragmentThoughts(fixture(), {
      query: " ALPHA ",
      selectedHistoryId: null,
    });
    expect(presentation.query).toBe("ALPHA");
    expect(presentation.thoughts.map((item) => item.thought.id)).toEqual([
      THOUGHT_B,
      THOUGHT_A,
    ]);

    const currentAndHistory = presentation.thoughts.find(
      (item) => item.thought.id === THOUGHT_A,
    )!;
    expect(currentAndHistory.current.matchCount).toBe(1);
    expect(currentAndHistory.current.matchRanges).toEqual([
      { start: 8, end: 13 },
    ]);
    expect(currentAndHistory.historicalVersionMatchCount).toBe(1);
    expect(currentAndHistory.historicalMatchCount).toBe(2);

    const historyOnly = presentation.thoughts.find(
      (item) => item.thought.id === THOUGHT_B,
    )!;
    expect(historyOnly.current.matchCount).toBe(0);
    expect(historyOnly.historicalVersionMatchCount).toBe(1);
    expect(historyOnly.historicalMatchCount).toBe(1);
  });

  it("reconciles history selection and temporarily expands matching collapsed versions", () => {
    const matching = projectFragmentThoughts(fixture(), {
      query: "alpha",
      selectedHistoryId: THOUGHT_A,
    });
    expect(matching.selectedHistoryId).toBe(THOUGHT_A);
    expect(matching.history?.versions[0]).toMatchObject({
      version: A_OLD,
      persistedCollapsed: true,
      collapsed: false,
      temporarilyExpanded: true,
      collapseLocked: true,
      matchCount: 2,
    });
    expect(matching.history?.versions[1]).toMatchObject({
      version: A_CURRENT,
      persistedCollapsed: false,
      collapsed: false,
      temporarilyExpanded: false,
      collapseLocked: true,
      matchCount: 1,
    });

    const restored = projectFragmentThoughts(fixture(), {
      query: "",
      selectedHistoryId: THOUGHT_A,
    });
    expect(restored.history?.versions[0]).toMatchObject({
      persistedCollapsed: true,
      collapsed: true,
      temporarilyExpanded: false,
      collapseLocked: false,
    });

    const filteredOut = projectFragmentThoughts(fixture(), {
      query: "alpha",
      selectedHistoryId: THOUGHT_C,
    });
    expect(filteredOut.selectedHistoryId).toBeNull();
    expect(filteredOut.history).toBeNull();
  });
});
