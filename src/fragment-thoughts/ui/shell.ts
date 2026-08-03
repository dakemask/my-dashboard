import { FragmentThoughtsFeedback } from "./feedback";
import { HistoryPanel } from "./historyPanel";
import { FragmentThoughtsPageShell } from "./pageShell";
import { ThoughtList } from "./thoughtList";
import type {
  DialogChoice,
  FragmentThoughtsShellCallbacks,
  MessageTone,
  ThoughtCardView,
  ThoughtHistoryView,
} from "./types";

export type {
  DialogChoice,
  FragmentThoughtsShellCallbacks,
  HighlightRange,
  MessageTone,
  ThoughtCardView,
  ThoughtHistoryVersionView,
  ThoughtHistoryView,
} from "./types";
export { renderSafeStartupFailure } from "./feedback";
export { formatTimestamp } from "./textPresentation";

export interface FragmentThoughtsShellElements {
  readonly root: HTMLElement;
  readonly homeLink: HTMLAnchorElement;
  readonly syncMount: HTMLElement;
  readonly saveFailure: HTMLElement;
  readonly retrySaveButton: HTMLButtonElement;
  readonly draftNotice: HTMLElement;
  readonly composerForm: HTMLFormElement;
  readonly composerInput: HTMLTextAreaElement;
  readonly composerError: HTMLElement;
  readonly composerClearButton: HTMLButtonElement;
  readonly composerSaveButton: HTMLButtonElement;
  readonly searchInput: HTMLInputElement;
  readonly searchClearButton: HTMLButtonElement;
  readonly searchStatus: HTMLElement;
  readonly thoughtList: HTMLElement;
  readonly listEmpty: HTMLElement;
  readonly historyPanel: HTMLElement;
  readonly historyTitle: HTMLElement;
  readonly historyCloseButton: HTMLButtonElement;
  readonly historyList: HTMLElement;
  readonly historyEmpty: HTMLElement;
  readonly toast: HTMLElement;
}

/**
 * Compatibility facade that assembles the page, thought list, history, and
 * feedback components without exposing their internal selectors to callers.
 */
export class FragmentThoughtsShell {
  readonly elements: FragmentThoughtsShellElements;

  readonly #page: FragmentThoughtsPageShell;
  readonly #thoughtList: ThoughtList;
  readonly #history: HistoryPanel;
  readonly #feedback: FragmentThoughtsFeedback;
  #binding: object | null = null;
  #disposed = false;

  constructor(appRoot: HTMLElement) {
    const document = appRoot.ownerDocument;
    this.#thoughtList = new ThoughtList(document);
    this.#page = new FragmentThoughtsPageShell(appRoot, {
      thoughtList: this.#thoughtList.root,
      listEmpty: this.#thoughtList.empty,
    });
    this.#feedback = new FragmentThoughtsFeedback(document);
    this.#history = new HistoryPanel({
      document,
      root: this.#page.elements.root,
      backgroundElements: () => [
        this.#page.elements.pageHeader,
        this.#page.elements.primaryColumn,
        this.#feedback.elements.draftNotice,
      ],
      showLockedMessage: (message) => this.#feedback.showMessage(message),
    });

    this.#page.elements.pageHeader.append(this.#feedback.elements.saveFailure);
    this.#page.elements.root.insertBefore(
      this.#feedback.elements.draftNotice,
      this.#page.elements.workspace,
    );
    this.#page.elements.workspace.append(this.#history.elements.panel);
    this.#page.elements.root.append(
      this.#feedback.elements.toast,
      this.#feedback.elements.dialog,
    );

    const page = this.#page.elements;
    const history = this.#history.elements;
    const feedback = this.#feedback.elements;
    this.elements = {
      root: page.root,
      homeLink: page.homeLink,
      syncMount: page.syncMount,
      saveFailure: feedback.saveFailure,
      retrySaveButton: feedback.retrySaveButton,
      draftNotice: feedback.draftNotice,
      composerForm: page.composerForm,
      composerInput: page.composerInput,
      composerError: page.composerError,
      composerClearButton: page.composerClearButton,
      composerSaveButton: page.composerSaveButton,
      searchInput: page.searchInput,
      searchClearButton: page.searchClearButton,
      searchStatus: page.searchStatus,
      thoughtList: this.#thoughtList.root,
      listEmpty: this.#thoughtList.empty,
      historyPanel: history.panel,
      historyTitle: history.title,
      historyCloseButton: history.closeButton,
      historyList: history.list,
      historyEmpty: history.empty,
      toast: feedback.toast,
    };
  }

  bindCallbacks(callbacks: FragmentThoughtsShellCallbacks): () => void {
    this.#assertAlive();
    const binding = {};
    this.#binding = binding;
    this.#page.setCallbacks(callbacks);
    this.#thoughtList.setCallbacks(callbacks);
    this.#history.setCallbacks(callbacks);
    this.#feedback.setCallbacks(callbacks);
    return () => {
      if (this.#binding !== binding) return;
      this.#binding = null;
      this.#page.setCallbacks(null);
      this.#thoughtList.setCallbacks({});
      this.#history.setCallbacks(null);
      this.#feedback.setCallbacks(null);
    };
  }

  getSyncMount(): HTMLElement {
    return this.#page.getSyncMount();
  }

  getComposerValue(): string {
    return this.#page.getComposerValue();
  }

  getSearchValue(): string {
    return this.#page.getSearchValue();
  }

  hasComposerDraft(): boolean {
    return this.#page.hasComposerDraft();
  }

  setSaveFailure(message: string | null): void {
    this.#feedback.setSaveFailure(message);
  }

  setDraftNotice(message: string | null): void {
    this.elements.root.classList.toggle("has-draft", message !== null);
    this.#feedback.setDraftNotice(message);
  }

  setComposerError(message: string | null): void {
    this.#page.setComposerError(message);
  }

  setComposerValue(value: string): void {
    this.#page.setComposerValue(value);
  }

  setComposerEnabled(enabled: boolean): void {
    this.#page.setComposerEnabled(enabled);
  }

  setSearchValue(value: string): void {
    this.#page.setSearchValue(value);
  }

  setSearchStatus(message: string | null): void {
    this.#page.setSearchStatus(message);
  }

  setMutationLocked(locked: boolean): void {
    this.#thoughtList.setMutationLocked(locked);
  }

  setEditError(thoughtId: string, message: string | null): void {
    this.#thoughtList.setEditError(thoughtId, message);
  }

  setHistoryCollapseDraftLocked(locked: boolean): void {
    this.#history.setDraftLocked(locked);
  }

  renderThoughts(
    thoughts: readonly ThoughtCardView[],
    emptyMessage?: string,
    availableThoughtIds?: readonly string[],
  ): void {
    this.#thoughtList.render(thoughts, emptyMessage, availableThoughtIds);
  }

  setHistoryOpen(open: boolean): void {
    this.#history.setOpen(open);
  }

  renderHistory(history: ThoughtHistoryView | null): void {
    this.#history.render(history);
  }

  showMessage(
    message: string,
    tone: MessageTone = "normal",
    duration?: number,
  ): void {
    this.#feedback.showMessage(message, tone, duration);
  }

  choose(
    title: string,
    message: string,
    choices: readonly DialogChoice[],
  ): Promise<string> {
    return this.#feedback.choose(title, message, choices);
  }

  focusComposer(): void {
    this.#page.focusComposer();
  }

  focusSearch(): void {
    this.#page.focusSearch();
  }

  focusEditor(thoughtId: string): void {
    this.#thoughtList.focusEditor(thoughtId);
  }

  focusHistoryClose(): void {
    this.#history.focusClose();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#binding = null;
    this.#page.dispose();
    this.#thoughtList.dispose();
    this.#history.dispose();
    this.#feedback.dispose();
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("Fragment Thoughts shell is disposed.");
  }
}
