import {
  Delete,
  Edit,
  History as HistoryIcon,
  Save,
  CloseSmall,
} from "@icon-park/svg";
import {
  createIconOnlyButton,
  createIconParkIcon,
} from "../../shared";
import type {
  FragmentThoughtsShellCallbacks,
  ThoughtCardView,
} from "./types";
import {
  appendHighlightedRanges,
  findLegacyHighlightRanges,
  formatTimestamp,
} from "./textPresentation";

type ThoughtListCallbacks = Pick<
  FragmentThoughtsShellCallbacks,
  | "onEditThought"
  | "onEditInput"
  | "onSaveEdit"
  | "onCancelEdit"
  | "onDeleteThought"
  | "onToggleHistory"
  | "onOpenMatchingHistory"
>;

interface ThoughtCardElements {
  readonly card: HTMLElement;
  readonly editorLabel: HTMLLabelElement;
  readonly editor: HTMLTextAreaElement;
  readonly highlight: HTMLElement;
  readonly error: HTMLElement;
  readonly historyMatch: HTMLButtonElement;
  readonly modified: HTMLTimeElement;
  readonly remove: HTMLButtonElement;
  readonly edit: HTMLButtonElement;
  readonly history: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly save: HTMLButtonElement;
  composing: boolean;
  mutationDisabled: boolean;
  editing: boolean;
  dispose: () => void;
}

export class ThoughtList {
  readonly root: HTMLElement;
  readonly empty: HTMLElement;

  readonly #cards = new Map<string, ThoughtCardElements>();
  #callbacks: ThoughtListCallbacks = {};
  #mutationLocked = false;
  #disposed = false;

  constructor(document: Document, callbacks: ThoughtListCallbacks = {}) {
    this.root = document.createElement("div");
    this.root.className = "ft-thought-list";
    this.empty = document.createElement("div");
    this.empty.className = "ft-empty-state";
    this.empty.textContent = "还没有想法。先记录第一条吧。";
    this.empty.hidden = true;
    this.#callbacks = callbacks;
  }

  setCallbacks(callbacks: ThoughtListCallbacks): void {
    this.#callbacks = callbacks;
  }

  render(
    thoughts: readonly ThoughtCardView[],
    emptyMessage = "还没有想法。先记录第一条吧。",
    availableThoughtIds: readonly string[] = thoughts.map(({ id }) => id),
  ): void {
    if (this.#disposed) return;
    const available = new Set(availableThoughtIds);
    for (const [thoughtId, elements] of this.#cards) {
      if (available.has(thoughtId)) continue;
      elements.card.remove();
      elements.dispose();
      this.#cards.delete(thoughtId);
    }

    const visibleIds = new Set(thoughts.map(({ id }) => id));
    for (const child of [...this.root.children]) {
      const thoughtId = (child as HTMLElement).dataset.thoughtId;
      if (!thoughtId || !visibleIds.has(thoughtId)) child.remove();
    }

    let reference = this.root.firstElementChild;
    for (const thought of thoughts) {
      let elements = this.#cards.get(thought.id);
      if (!elements) {
        elements = this.#createCard(thought.id);
        this.#cards.set(thought.id, elements);
      }
      this.#updateCard(elements, thought);
      if (elements.card !== reference) {
        this.root.insertBefore(elements.card, reference);
      }
      reference = elements.card.nextElementSibling;
    }

    this.empty.textContent = emptyMessage;
    this.empty.hidden = thoughts.length !== 0;
  }

  focusEditor(thoughtId: string): void {
    const editor = this.#cards.get(thoughtId)?.editor;
    if (!editor) return;
    editor.ownerDocument.defaultView?.queueMicrotask(() => {
      if (!editor.isConnected) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
  }

  setEditError(thoughtId: string, message: string | null): void {
    const elements = this.#cards.get(thoughtId);
    if (!elements) return;
    elements.error.textContent = message ?? "";
    elements.error.hidden = message === null;
    elements.editor.setAttribute("aria-invalid", String(message !== null));
  }

  setMutationLocked(locked: boolean): void {
    this.#mutationLocked = locked;
    for (const elements of this.#cards.values()) {
      this.#updateMutationState(elements);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const elements of this.#cards.values()) elements.dispose();
    this.#cards.clear();
    this.#callbacks = {};
  }

  #createCard(thoughtId: string): ThoughtCardElements {
    const document = this.root.ownerDocument;
    const card = document.createElement("article");
    card.className = "ft-thought-card";
    card.dataset.thoughtId = thoughtId;

    const editorLabel = document.createElement("label");
    editorLabel.className = "ft-visually-hidden";
    const editorId = `fragment-thought-edit-${safeDomId(thoughtId)}`;
    editorLabel.htmlFor = editorId;
    const textRegion = document.createElement("div");
    textRegion.className = "ft-thought-text-region";
    const highlight = document.createElement("div");
    highlight.className = "ft-thought-highlight";
    highlight.setAttribute("aria-hidden", "true");
    const editor = document.createElement("textarea");
    editor.id = editorId;
    editor.className = "ft-edit-input";
    editor.rows = 1;
    editor.dataset.role = "edit-input";
    editor.dataset.thoughtId = thoughtId;
    textRegion.append(highlight, editor);

    const error = document.createElement("p");
    error.id = `${editorId}-error`;
    error.className = "ft-field-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    editor.setAttribute("aria-describedby", error.id);

    const historyMatch = document.createElement("button");
    historyMatch.type = "button";
    historyMatch.className = "ft-history-match";
    historyMatch.dataset.action = "open-history-match";
    historyMatch.dataset.thoughtId = thoughtId;
    historyMatch.title = "打开历史并查看匹配内容";
    historyMatch.append(
      createIconParkIcon(document, HistoryIcon, { classNames: "ft-icon" }),
      createLabel(document, "历史命中"),
    );

    const footer = document.createElement("footer");
    footer.className = "ft-card-footer";
    const modified = document.createElement("time");
    modified.className = "ft-modified-time";
    const actions = document.createElement("div");
    actions.className = "ft-card-actions";
    const remove = createActionButton(document, Delete, "删除这条想法", "delete-thought", thoughtId, "ft-card-button ft-card-button-danger");
    const edit = createActionButton(document, Edit, "编辑这条想法", "edit-thought", thoughtId, "ft-card-button");
    const history = createActionButton(document, HistoryIcon, "查看这条想法的修改记录", "toggle-history", thoughtId, "ft-card-button");
    const cancel = createActionButton(document, CloseSmall, "取消这次编辑", "cancel-edit", thoughtId, "ft-card-button");
    const save = createActionButton(document, Save, "保存这次编辑", "save-edit", thoughtId, "ft-card-button ft-card-button-primary");
    actions.append(remove, edit, history, cancel, save);
    footer.append(modified, actions);
    card.append(editorLabel, textRegion, error, historyMatch, footer);

    const elements: ThoughtCardElements = {
      card,
      editorLabel,
      editor,
      highlight,
      error,
      historyMatch,
      modified,
      remove,
      edit,
      history,
      cancel,
      save,
      composing: false,
      mutationDisabled: false,
      editing: false,
      dispose: () => undefined,
    };
    const onInput = (): void => {
      resizeTextarea(editor);
      if (elements.composing) return;
      this.setEditError(thoughtId, null);
      this.#callbacks.onEditInput?.(thoughtId, editor.value);
    };
    const onCompositionStart = (): void => {
      elements.composing = true;
    };
    const onCompositionEnd = (): void => {
      elements.composing = false;
      resizeTextarea(editor);
      this.setEditError(thoughtId, null);
      this.#callbacks.onEditInput?.(thoughtId, editor.value);
    };
    const onClick = (event: Event): void => {
      const target = event.target;
      const pageWindow = card.ownerDocument.defaultView;
      if (!pageWindow || !(target instanceof pageWindow.Element)) return;
      const button = target.closest<HTMLButtonElement>("button[data-action]");
      if (!button || button.disabled) return;
      switch (button.dataset.action) {
        case "delete-thought": this.#callbacks.onDeleteThought?.(thoughtId); break;
        case "edit-thought": this.#callbacks.onEditThought?.(thoughtId); break;
        case "toggle-history": this.#callbacks.onToggleHistory?.(thoughtId); break;
        case "open-history-match": this.#callbacks.onOpenMatchingHistory?.(thoughtId); break;
        case "save-edit": this.#callbacks.onSaveEdit?.(thoughtId, editor.value); break;
        case "cancel-edit": this.#callbacks.onCancelEdit?.(thoughtId); break;
      }
    };
    editor.addEventListener("input", onInput);
    editor.addEventListener("compositionstart", onCompositionStart);
    editor.addEventListener("compositionend", onCompositionEnd);
    card.addEventListener("click", onClick);
    elements.dispose = () => {
      editor.removeEventListener("input", onInput);
      editor.removeEventListener("compositionstart", onCompositionStart);
      editor.removeEventListener("compositionend", onCompositionEnd);
      card.removeEventListener("click", onClick);
    };
    return elements;
  }

  #updateCard(elements: ThoughtCardElements, thought: ThoughtCardView): void {
    const editing = thought.editing === true;
    const editorValue = editing ? thought.editDraft ?? thought.content : thought.content;
    elements.card.classList.toggle("is-editing", editing);
    elements.card.classList.toggle("history-selected", thought.historyOpen === true);
    elements.editorLabel.textContent = editing ? "编辑想法内容" : "想法内容";
    if (!elements.composing && elements.editor.value !== editorValue) {
      elements.editor.value = editorValue;
    }
    elements.editor.readOnly = !editing;
    elements.editor.tabIndex = editing ? 0 : -1;
    this.setEditError(thought.id, thought.editError ?? null);

    const hasHighlight = appendHighlightedRanges(
      elements.highlight,
      thought.content,
      thought.highlightRanges
        ?? findLegacyHighlightRanges(
          thought.content,
          thought.highlightQuery ?? "",
        ),
    );
    const showHighlight = !editing && hasHighlight;
    elements.highlight.hidden = !showHighlight;
    elements.card.classList.toggle("has-highlight-mirror", showHighlight);

    const historyMatchCount = thought.historyMatchCount ?? 0;
    elements.historyMatch.hidden = editing || historyMatchCount === 0;
    elements.historyMatch.setAttribute("aria-label", `历史命中 ${historyMatchCount} 版`);
    const label = elements.historyMatch.querySelector(".ft-button-label");
    if (label) label.textContent = `历史命中 ${historyMatchCount} 版`;
    elements.modified.dateTime = thought.modifiedAt;
    elements.modified.title = thought.modifiedAt;
    elements.modified.textContent = `上次修改：${formatTimestamp(thought.modifiedAt)}`;
    elements.remove.hidden = editing;
    elements.edit.hidden = editing;
    elements.history.hidden = editing;
    elements.cancel.hidden = !editing;
    elements.save.hidden = !editing;
    elements.history.setAttribute("aria-pressed", String(thought.historyOpen === true));
    elements.mutationDisabled = thought.mutationsDisabled === true;
    elements.editing = editing;
    this.#updateMutationState(elements);
    resizeTextarea(elements.editor);
  }

  #updateMutationState(elements: ThoughtCardElements): void {
    const disabled = this.#mutationLocked || elements.mutationDisabled;
    elements.remove.disabled = !elements.editing && disabled;
    elements.edit.disabled = !elements.editing && disabled;
  }
}

function createActionButton(
  document: Document,
  icon: Parameters<typeof createIconOnlyButton>[1],
  label: string,
  action: string,
  thoughtId: string,
  classNames: string,
): HTMLButtonElement {
  const button = createIconOnlyButton(document, icon, label, {
    classNames: `${classNames} ft-icon-only`,
    iconClassNames: "ft-icon",
  });
  button.dataset.action = action;
  button.dataset.thoughtId = thoughtId;
  return button;
}

function createLabel(document: Document, text: string): HTMLElement {
  const label = document.createElement("span");
  label.className = "ft-button-label";
  label.textContent = text;
  return label;
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function resizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.rows = 1;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 1)}px`;
}
