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
      requireThought(payload, thoughtId);
      return validateFragmentThoughtsPayload({
        ...payload,
        thoughts: payload.thoughts.map((thought) => thought.id === thoughtId
          ? {
              ...thought,
              versions: [...thought.versions, version],
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
            }
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
      const afterThought = requireThought(after, thoughtId);
      const lastVersion = afterThought.versions.at(-1);
      if (lastVersion?.id !== version.id) {
        throw new TypeError("The appended Fragment Thought version is not the latest version.");
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
