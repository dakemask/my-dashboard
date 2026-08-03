import type {
  FragmentThought,
  FragmentThoughtsPayload,
  FragmentThoughtVersion,
} from "../domain";

export interface TextMatchRange {
  readonly start: number;
  readonly end: number;
}

export interface ThoughtVersionPresentation {
  readonly version: FragmentThoughtVersion;
  readonly matchRanges: readonly TextMatchRange[];
  readonly matchCount: number;
}

export interface ThoughtListItemPresentation {
  readonly thought: FragmentThought;
  readonly current: ThoughtVersionPresentation;
  readonly historicalVersions: readonly ThoughtVersionPresentation[];
  readonly historicalVersionMatchCount: number;
  readonly historicalMatchCount: number;
}

export interface ThoughtHistoryVersionPresentation
  extends ThoughtVersionPresentation {
  readonly persistedCollapsed: boolean;
  readonly collapsed: boolean;
  readonly temporarilyExpanded: boolean;
  readonly collapseLocked: boolean;
}

export interface ThoughtHistoryPresentation {
  readonly thoughtId: string;
  readonly versions: readonly ThoughtHistoryVersionPresentation[];
}

export interface FragmentThoughtsPresentation {
  readonly query: string;
  readonly thoughts: readonly ThoughtListItemPresentation[];
  readonly selectedHistoryId: string | null;
  readonly history: ThoughtHistoryPresentation | null;
}

export function normalizeSearchQuery(value: string): string {
  return value.trim();
}

/**
 * Finds non-overlapping ranges using JavaScript's Unicode simple case folding.
 * Filtering and every highlighter consume these exact ranges instead of
 * maintaining a second lowercase-based matching rule.
 */
export function findMatchRanges(
  text: string,
  queryValue: string,
): readonly TextMatchRange[] {
  const query = normalizeSearchQuery(queryValue);
  if (query.length === 0) return [];

  const matcher = new RegExp(escapeRegExp(query), "giu");
  const ranges: TextMatchRange[] = [];
  for (const match of text.matchAll(matcher)) {
    if (match.index === undefined || match[0].length === 0) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

export function projectFragmentThoughts(
  payload: FragmentThoughtsPayload,
  options: {
    readonly query: string;
    readonly selectedHistoryId: string | null;
  },
): FragmentThoughtsPresentation {
  const query = normalizeSearchQuery(options.query);
  const projected = payload.thoughts
    .map((thought) => projectThought(thought, query))
    .filter((thought) => query.length === 0 || thoughtMatches(thought))
    .sort(compareThoughtPresentations);

  const selected = options.selectedHistoryId === null
    ? null
    : projected.find(
      (candidate) => candidate.thought.id === options.selectedHistoryId,
    ) ?? null;
  const history = selected === null
    ? null
    : projectHistory(selected, query);

  return {
    query,
    thoughts: projected,
    selectedHistoryId: history?.thoughtId ?? null,
    history,
  };
}

function projectThought(
  thought: FragmentThought,
  query: string,
): ThoughtListItemPresentation {
  const currentVersion = thought.versions.at(-1);
  if (!currentVersion) throw new TypeError("A Fragment Thought has no versions.");

  const current = projectVersion(currentVersion, query);
  const historicalVersions = thought.versions
    .slice(0, -1)
    .map((version) => projectVersion(version, query));
  return {
    thought,
    current,
    historicalVersions,
    historicalVersionMatchCount: historicalVersions.filter(
      (version) => version.matchCount > 0,
    ).length,
    historicalMatchCount: historicalVersions.reduce(
      (total, version) => total + version.matchCount,
      0,
    ),
  };
}

function projectVersion(
  version: FragmentThoughtVersion,
  query: string,
): ThoughtVersionPresentation {
  const matchRanges = findMatchRanges(version.content, query);
  return {
    version,
    matchRanges,
    matchCount: matchRanges.length,
  };
}

function thoughtMatches(thought: ThoughtListItemPresentation): boolean {
  return thought.current.matchCount > 0
    || thought.historicalVersionMatchCount > 0;
}

function compareThoughtPresentations(
  left: ThoughtListItemPresentation,
  right: ThoughtListItemPresentation,
): number {
  const timeDifference = Date.parse(right.current.version.createdAt)
    - Date.parse(left.current.version.createdAt);
  if (timeDifference !== 0) return timeDifference;
  return left.thought.id < right.thought.id
    ? -1
    : left.thought.id > right.thought.id
      ? 1
      : 0;
}

function projectHistory(
  thought: ThoughtListItemPresentation,
  query: string,
): ThoughtHistoryPresentation {
  const collapsedIds = new Set(thought.thought.collapsedVersionIds);
  const versionsById = new Map(
    [...thought.historicalVersions, thought.current].map(
      (version) => [version.version.id, version] as const,
    ),
  );
  return {
    thoughtId: thought.thought.id,
    versions: thought.thought.versions.map((version) => {
      const projected = versionsById.get(version.id) ?? projectVersion(version, query);
      const persistedCollapsed = collapsedIds.has(version.id);
      const collapseLocked = query.length > 0 && projected.matchCount > 0;
      return {
        ...projected,
        persistedCollapsed,
        collapsed: persistedCollapsed && !collapseLocked,
        temporarilyExpanded: persistedCollapsed && collapseLocked,
        collapseLocked,
      };
    }),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
