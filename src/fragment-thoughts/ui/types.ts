export type MessageTone = "normal" | "success" | "error";

export interface HighlightRange {
  readonly start: number;
  readonly end: number;
}

export interface DialogChoice {
  readonly id: string;
  readonly label: string;
  readonly tone?: "primary" | "danger" | "neutral";
}

export interface ThoughtCardView {
  readonly id: string;
  readonly content: string;
  readonly modifiedAt: string;
  readonly historyMatchCount?: number;
  readonly highlightRanges?: readonly HighlightRange[];
  /** @deprecated Pass highlightRanges from the presentation pipeline. */
  readonly highlightQuery?: string;
  readonly editing?: boolean;
  readonly editDraft?: string;
  readonly editError?: string | null;
  readonly historyOpen?: boolean;
  readonly mutationsDisabled?: boolean;
}

export interface ThoughtHistoryVersionView {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly collapsed?: boolean;
  readonly collapseLockedMessage?: string;
  readonly highlightRanges?: readonly HighlightRange[];
  /** @deprecated Pass highlightRanges from the presentation pipeline. */
  readonly highlightQuery?: string;
}

export interface ThoughtHistoryView {
  readonly thoughtId: string;
  readonly versions: readonly ThoughtHistoryVersionView[];
}

export interface FragmentThoughtsShellCallbacks {
  readonly onComposerInput?: (value: string) => void;
  readonly onComposerSubmit?: (value: string) => void;
  readonly onComposerClear?: () => void;
  readonly onSearchInput?: (value: string) => void;
  readonly onSearchClear?: () => void;
  readonly onRetrySave?: () => void;
  readonly onEditThought?: (thoughtId: string) => void;
  readonly onEditInput?: (thoughtId: string, value: string) => void;
  readonly onSaveEdit?: (thoughtId: string, value: string) => void;
  readonly onCancelEdit?: (thoughtId: string) => void;
  readonly onDeleteThought?: (thoughtId: string) => void;
  readonly onToggleHistory?: (thoughtId: string) => void;
  readonly onOpenMatchingHistory?: (thoughtId: string) => void;
  readonly onCloseHistory?: () => void;
  readonly onToggleHistoryVersion?: (
    thoughtId: string,
    versionId: string,
  ) => void;
}
