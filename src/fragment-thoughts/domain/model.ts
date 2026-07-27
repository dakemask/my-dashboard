import type {
  FragmentThought,
  FragmentThoughtsPayload,
  FragmentThoughtVersion,
} from "./types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createEmptyFragmentThoughtsPayload(): FragmentThoughtsPayload {
  return {
    thoughts: [],
  };
}

/**
 * Converts browser and imported text line endings to the persisted LF form.
 * All other whitespace is retained exactly.
 */
export function normalizeFragmentThoughtContent(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Fragment Thought content must be a string.");
  }
  const content = value.replace(/\r\n?/g, "\n");
  if (content.trim().length === 0) {
    throw new TypeError("Fragment Thought content cannot be blank.");
  }
  return content;
}

export function validateFragmentThoughtVersion(value: unknown): FragmentThoughtVersion {
  const record = requireExactRecord(
    value,
    ["id", "content", "createdAt"],
    "Fragment Thought version",
  );
  return {
    id: validateFragmentThoughtId(record.id, "Fragment Thought version id"),
    content: normalizeFragmentThoughtContent(record.content as string),
    createdAt: validateFragmentThoughtTimestamp(record.createdAt),
  };
}

export function validateFragmentThought(value: unknown): FragmentThought {
  const record = requireExactRecord(
    value,
    ["id", "versions", "collapsedVersionIds"],
    "Fragment Thought",
  );
  if (!Array.isArray(record.versions) || record.versions.length === 0) {
    throw new TypeError("A Fragment Thought must contain at least one version.");
  }
  if (!Array.isArray(record.collapsedVersionIds)) {
    throw new TypeError("Fragment Thought collapsedVersionIds must be an array.");
  }

  const versions = record.versions.map(validateFragmentThoughtVersion);
  for (let index = 1; index < versions.length; index += 1) {
    const previous = versions[index - 1]!;
    const current = versions[index]!;
    if (Date.parse(current.createdAt) <= Date.parse(previous.createdAt)) {
      throw new TypeError("Fragment Thought version timestamps must be strictly increasing.");
    }
  }
  const versionIds = new Set(versions.map((version) => version.id));
  const collapsedIds = new Set<string>();
  for (const value of record.collapsedVersionIds) {
    const id = validateFragmentThoughtId(value, "Collapsed Fragment Thought version id");
    if (!versionIds.has(id)) {
      throw new TypeError(`Collapsed Fragment Thought version does not exist: ${id}`);
    }
    if (collapsedIds.has(id)) {
      throw new TypeError(`Duplicate collapsed Fragment Thought version id: ${id}`);
    }
    collapsedIds.add(id);
  }

  return {
    id: validateFragmentThoughtId(record.id, "Fragment Thought id"),
    versions,
    collapsedVersionIds: versions
      .filter((version) => collapsedIds.has(version.id))
      .map((version) => version.id),
  };
}

/**
 * Validates every business invariant and returns a detached canonical payload.
 * Thought array order is not business data, so it is normalized by id.
 */
export function validateFragmentThoughtsPayload(value: unknown): FragmentThoughtsPayload {
  const record = requireExactRecord(
    value,
    ["thoughts"],
    "Fragment Thoughts payload",
  );
  if (!Array.isArray(record.thoughts)) {
    throw new TypeError("Fragment Thoughts payload thoughts must be an array.");
  }

  const thoughts = record.thoughts.map(validateFragmentThought);
  const ids = new Set<string>();
  for (const thought of thoughts) {
    claimUniqueId(ids, thought.id);
    for (const version of thought.versions) claimUniqueId(ids, version.id);
  }

  return {
    thoughts: [...thoughts].sort(compareThoughtIds),
  };
}

export function validateFragmentThoughtId(value: unknown, label = "Fragment Thought id"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

export function validateFragmentThoughtTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Fragment Thought createdAt must be a UTC ISO timestamp.");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError("Fragment Thought createdAt must be a canonical UTC ISO timestamp.");
  }
  return value;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(`${label} has unexpected or missing properties.`);
  }
  return record;
}

function claimUniqueId(ids: Set<string>, id: string): void {
  if (ids.has(id)) throw new TypeError(`Duplicate Fragment Thought id: ${id}`);
  ids.add(id);
}

function compareThoughtIds(left: FragmentThought, right: FragmentThought): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
