import {
  validateFragmentThought,
  validateFragmentThoughtId,
  validateFragmentThoughtsPayload,
  validateFragmentThoughtVersion,
} from "./model";
import type {
  FragmentThought,
  FragmentThoughtsEvent,
  FragmentThoughtsPayload,
} from "./types";

export function applyFragmentThoughtsEvent(
  payloadValue: FragmentThoughtsPayload,
  event: FragmentThoughtsEvent,
): FragmentThoughtsPayload {
  const payload = validateFragmentThoughtsPayload(payloadValue);

  switch (event.type) {
    case "insert-thought": {
      const thought = validateFragmentThought(event.thought);
      return validateFragmentThoughtsPayload({
        ...payload,
        thoughts: [...payload.thoughts, thought],
      });
    }
    case "delete-thought": {
      const thoughtId = validateFragmentThoughtId(event.thoughtId);
      requireThought(payload, thoughtId);
      return validateFragmentThoughtsPayload({
        ...payload,
        thoughts: payload.thoughts.filter((thought) => thought.id !== thoughtId),
      });
    }
    case "append-version": {
      const thoughtId = validateFragmentThoughtId(event.thoughtId);
      const version = validateFragmentThoughtVersion(event.version);
      const collapsed = requireBoolean(event.collapsed, "Appended version collapsed state");
      requireThought(payload, thoughtId);
      return validateFragmentThoughtsPayload({
        ...payload,
        thoughts: payload.thoughts.map((thought) => thought.id === thoughtId
          ? {
              ...thought,
              versions: [...thought.versions, version],
              collapsedVersionIds: collapsed
                ? [...thought.collapsedVersionIds, version.id]
                : thought.collapsedVersionIds,
            }
          : thought),
      });
    }
    case "remove-last-version": {
      const thoughtId = validateFragmentThoughtId(event.thoughtId);
      const versionId = validateFragmentThoughtId(
        event.versionId,
        "Fragment Thought version id",
      );
      const thought = requireThought(payload, thoughtId);
      if (thought.versions.length === 1) {
        throw new TypeError("The only Fragment Thought version cannot be removed.");
      }
      const lastVersion = thought.versions.at(-1)!;
      if (lastVersion.id !== versionId) {
        throw new TypeError("Only the latest Fragment Thought version can be removed.");
      }
      return validateFragmentThoughtsPayload({
        ...payload,
        thoughts: payload.thoughts.map((candidate) => candidate.id === thoughtId
          ? {
              ...candidate,
              versions: candidate.versions.slice(0, -1),
              collapsedVersionIds: candidate.collapsedVersionIds.filter(
                (id) => id !== versionId,
              ),
            }
          : candidate),
      });
    }
    case "set-version-collapsed": {
      const thoughtId = validateFragmentThoughtId(event.thoughtId);
      const versionId = validateFragmentThoughtId(
        event.versionId,
        "Fragment Thought version id",
      );
      const collapsed = requireBoolean(event.collapsed, "Version collapsed state");
      const thought = requireThought(payload, thoughtId);
      requireVersion(thought, versionId);
      const collapsedIds = new Set(thought.collapsedVersionIds);
      if (collapsed) collapsedIds.add(versionId);
      else collapsedIds.delete(versionId);
      return validateFragmentThoughtsPayload({
        ...payload,
        thoughts: payload.thoughts.map((candidate) => candidate.id === thoughtId
          ? { ...candidate, collapsedVersionIds: [...collapsedIds] }
          : candidate),
      });
    }
  }
}

export function invertFragmentThoughtsEvent(
  event: FragmentThoughtsEvent,
  beforeValue: FragmentThoughtsPayload,
  afterValue: FragmentThoughtsPayload,
): FragmentThoughtsEvent {
  const before = validateFragmentThoughtsPayload(beforeValue);
  const after = validateFragmentThoughtsPayload(afterValue);

  switch (event.type) {
    case "insert-thought": {
      const thought = validateFragmentThought(event.thought);
      requireThought(after, thought.id);
      return { type: "delete-thought", thoughtId: thought.id };
    }
    case "delete-thought": {
      const thoughtId = validateFragmentThoughtId(event.thoughtId);
      return {
        type: "insert-thought",
        thought: requireThought(before, thoughtId),
      };
    }
    case "append-version": {
      const thoughtId = validateFragmentThoughtId(event.thoughtId);
      const version = validateFragmentThoughtVersion(event.version);
      const collapsed = requireBoolean(event.collapsed, "Appended version collapsed state");
      const afterThought = requireThought(after, thoughtId);
      const lastVersion = afterThought.versions.at(-1);
      if (lastVersion?.id !== version.id) {
        throw new TypeError("The appended Fragment Thought version is not the latest version.");
      }
      if (afterThought.collapsedVersionIds.includes(version.id) !== collapsed) {
        throw new TypeError("The appended Fragment Thought collapsed state is inconsistent.");
      }
      return {
        type: "remove-last-version",
        thoughtId,
        versionId: version.id,
      };
    }
    case "remove-last-version": {
      const thoughtId = validateFragmentThoughtId(event.thoughtId);
      const versionId = validateFragmentThoughtId(
        event.versionId,
        "Fragment Thought version id",
      );
      const version = requireThought(before, thoughtId).versions.at(-1);
      if (version?.id !== versionId) {
        throw new TypeError("The removed Fragment Thought version was not the latest version.");
      }
      return {
        type: "append-version",
        thoughtId,
        version,
        collapsed: requireThought(before, thoughtId).collapsedVersionIds.includes(versionId),
      };
    }
    case "set-version-collapsed": {
      const thoughtId = validateFragmentThoughtId(event.thoughtId);
      const versionId = validateFragmentThoughtId(
        event.versionId,
        "Fragment Thought version id",
      );
      requireBoolean(event.collapsed, "Version collapsed state");
      const beforeThought = requireThought(before, thoughtId);
      requireVersion(beforeThought, versionId);
      const afterThought = requireThought(after, thoughtId);
      requireVersion(afterThought, versionId);
      if (afterThought.collapsedVersionIds.includes(versionId) !== event.collapsed) {
        throw new TypeError("The Fragment Thought collapsed state is inconsistent.");
      }
      return {
        type: "set-version-collapsed",
        thoughtId,
        versionId,
        collapsed: beforeThought.collapsedVersionIds.includes(versionId),
      };
    }
  }
}

function requireThought(
  payload: FragmentThoughtsPayload,
  thoughtId: string,
): FragmentThought {
  const thought = payload.thoughts.find((candidate) => candidate.id === thoughtId);
  if (!thought) throw new TypeError(`Fragment Thought does not exist: ${thoughtId}`);
  return thought;
}

function requireVersion(thought: FragmentThought, versionId: string): void {
  if (!thought.versions.some((version) => version.id === versionId)) {
    throw new TypeError(`Fragment Thought version does not exist: ${versionId}`);
  }
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}
