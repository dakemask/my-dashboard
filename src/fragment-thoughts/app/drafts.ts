import {
  normalizeFragmentThoughtContent,
  type FragmentThought,
  type FragmentThoughtsEvent,
  type FragmentThoughtsPayload,
  type FragmentThoughtVersion,
} from "../domain";

export type FragmentThoughtDraftError = "blank";

export type FragmentThoughtDraft =
  | {
      readonly kind: "idle";
      readonly composerError: FragmentThoughtDraftError | null;
    }
  | {
      readonly kind: "composer";
      readonly value: string;
      readonly error: FragmentThoughtDraftError | null;
    }
  | {
      readonly kind: "editing";
      readonly thoughtId: string;
      readonly original: string;
      readonly value: string;
      readonly error: FragmentThoughtDraftError | null;
    };

export type PendingDraftApplication =
  | {
      readonly kind: "insert";
      readonly thoughtId: string;
      readonly sourceValue: string;
    }
  | {
      readonly kind: "edit";
      readonly thoughtId: string;
      readonly versionId: string;
      readonly sourceValue: string;
    };

export type DraftGateResult =
  | { readonly status: "ready" }
  | {
      readonly status: "blocked";
      readonly draftKind: "composer" | "editing";
    };

export interface DraftSettlementFactories {
  readonly createThought: (content: string) => FragmentThought;
  readonly createVersion: (
    content: string,
    thought: FragmentThought,
  ) => FragmentThoughtVersion;
}

export type DraftSettleResult =
  | {
      readonly status: "no-change";
      readonly reason: "idle";
      readonly draft: FragmentThoughtDraft;
    }
  | {
      readonly status: "invalid";
      readonly reason: "blank";
      readonly draft: FragmentThoughtDraft;
    }
  | {
      readonly status: "discarded";
      readonly reason: "blank" | "unchanged" | "missing-thought";
      readonly draft: FragmentThoughtDraft;
    }
  | {
      readonly status: "ready";
      readonly draft: FragmentThoughtDraft;
      readonly event: FragmentThoughtsEvent;
      readonly pending: PendingDraftApplication;
    };

export interface CompletedDraftApplication {
  readonly applied: boolean;
  readonly draft: FragmentThoughtDraft;
  readonly pending: PendingDraftApplication | null;
}

export function createIdleDraft(): FragmentThoughtDraft {
  return { kind: "idle", composerError: null };
}

export function setComposerDraft(
  draft: FragmentThoughtDraft,
  value: string,
): FragmentThoughtDraft {
  if (draft.kind === "editing") return draft;
  return value.length === 0
    ? createIdleDraft()
    : { kind: "composer", value, error: null };
}

export function beginEditingDraft(
  draft: FragmentThoughtDraft,
  thought: FragmentThought,
): FragmentThoughtDraft {
  if (hasActiveDraft(draft)) return draft;
  const latest = latestVersion(thought);
  return {
    kind: "editing",
    thoughtId: thought.id,
    original: latest.content,
    value: latest.content,
    error: null,
  };
}

export function updateEditingDraft(
  draft: FragmentThoughtDraft,
  thoughtId: string,
  value: string,
): FragmentThoughtDraft {
  if (draft.kind !== "editing" || draft.thoughtId !== thoughtId) return draft;
  return { ...draft, value, error: null };
}

export function clearDraftError(
  draft: FragmentThoughtDraft,
): FragmentThoughtDraft {
  switch (draft.kind) {
    case "idle":
      return draft.composerError === null
        ? draft
        : { ...draft, composerError: null };
    case "composer":
    case "editing":
      return draft.error === null ? draft : { ...draft, error: null };
  }
}

export function discardDraft(): FragmentThoughtDraft {
  return createIdleDraft();
}

export function hasActiveDraft(draft: FragmentThoughtDraft): boolean {
  return draft.kind !== "idle";
}

export function hasEditingChanges(draft: FragmentThoughtDraft): boolean {
  return draft.kind === "editing" && draft.value !== draft.original;
}

export function getDraftGate(draft: FragmentThoughtDraft): DraftGateResult {
  return draft.kind === "idle"
    ? { status: "ready" }
    : { status: "blocked", draftKind: draft.kind };
}

export function reconcileDraftWithPayload(
  draft: FragmentThoughtDraft,
  payload: FragmentThoughtsPayload,
): FragmentThoughtDraft {
  if (
    draft.kind === "editing"
    && !payload.thoughts.some((thought) => thought.id === draft.thoughtId)
  ) {
    return createIdleDraft();
  }
  return draft;
}

/**
 * Converts one complete draft into at most one business event. The draft is
 * retained until the caller proves that the event reached the payload via
 * `completePendingDraftApplication`, so a failed dispatch never loses text.
 */
export function settleDraft(
  draft: FragmentThoughtDraft,
  payload: FragmentThoughtsPayload,
  options: DraftSettlementFactories & {
    readonly reason: "manual" | "remote-change";
  },
): DraftSettleResult {
  if (draft.kind === "idle") {
    if (options.reason === "remote-change") {
      return { status: "no-change", reason: "idle", draft };
    }
    return {
      status: "invalid",
      reason: "blank",
      draft: { ...draft, composerError: "blank" },
    };
  }

  const content = normalizeDraft(draft.value);
  if (content === null) {
    if (options.reason === "remote-change") {
      return {
        status: "discarded",
        reason: "blank",
        draft: createIdleDraft(),
      };
    }
    return {
      status: "invalid",
      reason: "blank",
      draft: { ...draft, error: "blank" },
    };
  }

  if (draft.kind === "composer") {
    const thought = options.createThought(content);
    return {
      status: "ready",
      draft,
      event: { type: "insert-thought", thought },
      pending: {
        kind: "insert",
        thoughtId: thought.id,
        sourceValue: draft.value,
      },
    };
  }

  const thought = payload.thoughts.find(
    (candidate) => candidate.id === draft.thoughtId,
  );
  if (!thought) {
    return {
      status: "discarded",
      reason: "missing-thought",
      draft: createIdleDraft(),
    };
  }
  if (content === latestVersion(thought).content) {
    return {
      status: "discarded",
      reason: "unchanged",
      draft: createIdleDraft(),
    };
  }

  const version = options.createVersion(content, thought);
  return {
    status: "ready",
    draft,
    event: {
      type: "append-version",
      thoughtId: thought.id,
      version,
    },
    pending: {
      kind: "edit",
      thoughtId: thought.id,
      versionId: version.id,
      sourceValue: draft.value,
    },
  };
}

/** Clears only the exact draft whose event is now visible in the payload. */
export function completePendingDraftApplication(
  draft: FragmentThoughtDraft,
  pending: PendingDraftApplication,
  payload: FragmentThoughtsPayload,
): CompletedDraftApplication {
  const thought = payload.thoughts.find(
    (candidate) => candidate.id === pending.thoughtId,
  );
  const applied = pending.kind === "insert"
    ? thought !== undefined
    : thought?.versions.at(-1)?.id === pending.versionId;
  if (!applied) return { applied: false, draft, pending };

  const stillRepresentsSettledDraft = pending.kind === "insert"
    ? draft.kind === "composer" && draft.value === pending.sourceValue
    : draft.kind === "editing"
      && draft.thoughtId === pending.thoughtId
      && draft.value === pending.sourceValue;
  return {
    applied: true,
    draft: stillRepresentsSettledDraft ? createIdleDraft() : draft,
    pending: null,
  };
}

function normalizeDraft(value: string): string | null {
  try {
    return normalizeFragmentThoughtContent(value);
  } catch {
    return null;
  }
}

function latestVersion(thought: FragmentThought): FragmentThoughtVersion {
  const version = thought.versions.at(-1);
  if (!version) throw new TypeError("A Fragment Thought has no versions.");
  return version;
}
