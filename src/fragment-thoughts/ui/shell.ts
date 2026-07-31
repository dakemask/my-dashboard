import {
  CloseSmall,
  Delete,
  Down,
  Edit,
  History as HistoryIcon,
  Home,
  Save,
  Search,
} from "@icon-park/svg";

type IconRenderer = typeof Search;

const HISTORY_TRANSITION_MS = 340;

export type MessageTone = "normal" | "success" | "error";

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
  readonly highlightQuery?: string;
}

export interface ThoughtHistoryView {
  readonly thoughtId: string;
  readonly versions: readonly ThoughtHistoryVersionView[];
}

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
}

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

export class FragmentThoughtsShell {
  readonly elements: FragmentThoughtsShellElements;

  readonly #dialog: HTMLDialogElement;
  readonly #dialogTitle: HTMLElement;
  readonly #dialogMessage: HTMLElement;
  readonly #dialogActions: HTMLElement;
  readonly #pageHeader: HTMLElement;
  readonly #primaryColumn: HTMLElement;
  readonly #draftNotice: HTMLElement;
  #dialogResolve: ((choice: string) => void) | null = null;
  #toastTimer: number | null = null;
  #historyCloseTimer: number | null = null;
  #historyReturnFocus: HTMLElement | null = null;
  #mobileHistoryQuery: MediaQueryList | null = null;
  readonly #thoughtCards = new Map<string, ThoughtCardElements>();
  readonly #onMobileHistoryChange = (event: MediaQueryListEvent): void => {
    if (this.elements.root.classList.contains("history-open")) {
      this.#setHistoryBackgroundInert(event.matches);
    }
  };

  constructor(appRoot: HTMLElement) {
    const document = appRoot.ownerDocument;
    const root = document.createElement("main");
    root.className = "fragment-thoughts-app";

    const pageHeader = document.createElement("header");
    pageHeader.className = "ft-page-header";
    const headerBar = document.createElement("div");
    headerBar.className = "ft-header-bar";

    const identity = document.createElement("div");
    identity.className = "ft-identity";
    const titleCopy = document.createElement("div");
    titleCopy.className = "ft-title-copy";
    const eyebrow = document.createElement("p");
    eyebrow.className = "ft-eyebrow";
    eyebrow.textContent = "MY DASHBOARD";
    const titleRow = document.createElement("div");
    titleRow.className = "ft-title-row";
    const title = document.createElement("h1");
    title.textContent = "碎片想法";
    const homeLink = document.createElement("a");
    homeLink.className = "ft-home-link ft-icon-only";
    homeLink.href = new URL(
      import.meta.env.BASE_URL,
      document.location.href,
    ).href;
    homeLink.title = "返回首页";
    homeLink.setAttribute("aria-label", "返回首页");
    homeLink.append(createIcon(document, Home));
    titleRow.append(title);
    const subtitle = document.createElement("p");
    subtitle.className = "ft-subtitle";
    subtitle.textContent = "快速记录你的想法。";
    titleCopy.append(eyebrow, titleRow, subtitle);
    identity.append(homeLink, titleCopy);

    const syncMount = document.createElement("div");
    syncMount.className = "ft-sync-mount";

    const saveFailure = document.createElement("div");
    saveFailure.className = "ft-save-failure";
    saveFailure.setAttribute("role", "alert");
    saveFailure.hidden = true;
    const saveFailureText = document.createElement("span");
    saveFailureText.textContent = "自动保存失败，当前页面内容仍然保留。";
    const retrySaveButton = createButton(
      document,
      "重试保存",
      "重新保存到本机",
      "ft-text-button",
    );
    retrySaveButton.dataset.action = "retry-save";
    saveFailure.append(saveFailureText, retrySaveButton);
    headerBar.append(identity, syncMount);
    pageHeader.append(headerBar, saveFailure);

    const draftNotice = document.createElement("div");
    draftNotice.className = "ft-draft-notice";
    draftNotice.setAttribute("role", "status");
    draftNotice.setAttribute("aria-live", "polite");
    draftNotice.hidden = true;

    const workspace = document.createElement("div");
    workspace.className = "ft-workspace";

    const primaryColumn = document.createElement("div");
    primaryColumn.className = "ft-primary-column";

    const composer = document.createElement("section");
    composer.className = "ft-composer";
    composer.setAttribute(
      "aria-labelledby",
      "fragment-thoughts-composer-title",
    );
    const composerHeading = document.createElement("div");
    composerHeading.className = "ft-section-heading";
    const composerTitle = document.createElement("h2");
    composerTitle.id = "fragment-thoughts-composer-title";
    composerTitle.textContent = "记录新想法";
    composerHeading.append(composerTitle);

    const composerForm = document.createElement("form");
    composerForm.className = "ft-composer-form";
    composerForm.noValidate = true;
    const composerLabel = document.createElement("label");
    composerLabel.className = "ft-visually-hidden";
    composerLabel.htmlFor = "fragment-thoughts-composer";
    composerLabel.textContent = "想法内容";
    const composerInput = document.createElement("textarea");
    composerInput.id = "fragment-thoughts-composer";
    composerInput.className = "ft-composer-input";
    composerInput.name = "content";
    composerInput.rows = 7;
    composerInput.autocomplete = "off";
    composerInput.setAttribute(
      "aria-describedby",
      "fragment-thoughts-composer-error",
    );
    const composerError = document.createElement("p");
    composerError.id = "fragment-thoughts-composer-error";
    composerError.className = "ft-field-error";
    composerError.setAttribute("role", "alert");
    composerError.hidden = true;
    const composerActions = document.createElement("div");
    composerActions.className = "ft-composer-actions";
    const composerClearButton = createButton(
      document,
      "清空",
      "清空当前草稿",
      "ft-button ft-button-subtle",
      CloseSmall,
      true,
    );
    composerClearButton.dataset.action = "clear-composer";
    composerClearButton.hidden = true;
    const composerSaveButton = createButton(
      document,
      "保存想法",
      "保存这条想法",
      "ft-button ft-button-primary",
      Save,
    );
    composerSaveButton.type = "submit";
    composerSaveButton.dataset.action = "save-thought";
    composerActions.append(composerClearButton, composerSaveButton);
    composerForm.append(
      composerLabel,
      composerInput,
      composerError,
      composerActions,
    );
    composer.append(composerHeading, composerForm);

    const browseSection = document.createElement("section");
    browseSection.className = "ft-browse";
    browseSection.setAttribute(
      "aria-labelledby",
      "fragment-thoughts-list-title",
    );
    const browseHeading = document.createElement("div");
    browseHeading.className = "ft-browse-heading";
    const listTitle = document.createElement("h2");
    listTitle.id = "fragment-thoughts-list-title";
    listTitle.textContent = "全部想法";
    const searchWrap = document.createElement("div");
    searchWrap.className = "ft-search-wrap";
    const searchLabel = document.createElement("label");
    searchLabel.className = "ft-visually-hidden";
    searchLabel.htmlFor = "fragment-thoughts-search";
    searchLabel.textContent = "搜索想法";
    const searchIcon = createIcon(document, Search, "ft-search-icon");
    const searchInput = document.createElement("input");
    searchInput.id = "fragment-thoughts-search";
    searchInput.type = "search";
    searchInput.placeholder = "搜索想法";
    searchInput.autocomplete = "off";
    const searchClearButton = createButton(
      document,
      "清除",
      "清除搜索内容",
      "ft-search-clear",
      CloseSmall,
      true,
    );
    searchClearButton.dataset.action = "clear-search";
    searchClearButton.hidden = true;
    searchWrap.append(searchLabel, searchIcon, searchInput, searchClearButton);
    browseHeading.append(listTitle, searchWrap);
    const searchStatus = document.createElement("p");
    searchStatus.className = "ft-search-status";
    searchStatus.setAttribute("role", "status");
    searchStatus.setAttribute("aria-live", "polite");
    searchStatus.hidden = true;
    const thoughtList = document.createElement("div");
    thoughtList.className = "ft-thought-list";
    const listEmpty = document.createElement("div");
    listEmpty.className = "ft-empty-state";
    listEmpty.textContent = "还没有想法。先记录第一条吧。";
    listEmpty.hidden = true;
    browseSection.append(browseHeading, searchStatus, thoughtList, listEmpty);

    primaryColumn.append(composer, browseSection);

    const historyPanel = document.createElement("aside");
    historyPanel.className = "ft-history-panel";
    historyPanel.setAttribute("aria-label", "修改记录");
    historyPanel.setAttribute("aria-hidden", "true");
    historyPanel.hidden = true;
    const historyHeader = document.createElement("header");
    historyHeader.className = "ft-history-header";
    const historyHeadingGroup = document.createElement("div");
    const historyTitle = document.createElement("h2");
    historyTitle.textContent = "修改记录";
    historyHeadingGroup.append(historyTitle);
    const historyCloseButton = createButton(
      document,
      "关闭",
      "关闭历史记录",
      "ft-icon-button",
      CloseSmall,
      true,
    );
    historyCloseButton.dataset.action = "close-history";
    historyHeader.append(historyHeadingGroup, historyCloseButton);
    const historyList = document.createElement("div");
    historyList.className = "ft-history-list";
    const historyEmpty = document.createElement("div");
    historyEmpty.className = "ft-empty-state ft-history-empty";
    historyEmpty.textContent = "这条想法暂无历史记录。";
    historyEmpty.hidden = true;
    historyPanel.append(historyHeader, historyList, historyEmpty);

    workspace.append(primaryColumn, historyPanel);

    const toast = document.createElement("div");
    toast.className = "ft-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.hidden = true;

    const dialog = document.createElement("dialog");
    dialog.className = "ft-dialog";
    const dialogTitle = document.createElement("h2");
    dialogTitle.id = "fragment-thoughts-dialog-title";
    dialogTitle.className = "ft-dialog-title";
    const dialogMessage = document.createElement("p");
    dialogMessage.id = "fragment-thoughts-dialog-message";
    dialogMessage.className = "ft-dialog-message";
    const dialogActions = document.createElement("div");
    dialogActions.className = "ft-dialog-actions";
    dialog.setAttribute("aria-labelledby", dialogTitle.id);
    dialog.setAttribute("aria-describedby", dialogMessage.id);
    dialog.append(dialogTitle, dialogMessage, dialogActions);

    root.append(pageHeader, draftNotice, workspace, toast, dialog);
    appRoot.replaceChildren(root);

    this.#dialog = dialog;
    this.#dialogTitle = dialogTitle;
    this.#dialogMessage = dialogMessage;
    this.#dialogActions = dialogActions;
    this.#pageHeader = pageHeader;
    this.#primaryColumn = primaryColumn;
    this.#draftNotice = draftNotice;
    this.elements = {
      root,
      homeLink,
      syncMount,
      saveFailure,
      retrySaveButton,
      draftNotice,
      composerForm,
      composerInput,
      composerError,
      composerClearButton,
      composerSaveButton,
      searchInput,
      searchClearButton,
      searchStatus,
      thoughtList,
      listEmpty,
      historyPanel,
      historyTitle,
      historyCloseButton,
      historyList,
      historyEmpty,
      toast,
    };
    this.#mobileHistoryQuery =
      document.defaultView?.matchMedia?.("(max-width: 820px)") ?? null;
    this.#mobileHistoryQuery?.addEventListener(
      "change",
      this.#onMobileHistoryChange,
    );

    composerInput.addEventListener("input", () => {
      composerClearButton.hidden = composerInput.value.length === 0;
      resizeTextarea(composerInput, 7);
    });
    searchInput.addEventListener("input", () => {
      searchClearButton.hidden = searchInput.value.length === 0;
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.#resolveDialog("cancel");
    });
  }

  setSaveFailure(message: string | null): void {
    const text = this.elements.saveFailure.firstElementChild;
    if (text) {
      text.textContent = message ?? "自动保存失败，当前页面内容仍然保留。";
    }
    this.elements.saveFailure.hidden = message === null;
  }

  setDraftNotice(message: string | null): void {
    this.elements.root.classList.toggle("has-draft", message !== null);
    this.elements.draftNotice.textContent = message ?? "";
    this.elements.draftNotice.hidden = message === null;
  }

  setComposerError(message: string | null): void {
    this.elements.composerError.textContent = message ?? "";
    this.elements.composerError.hidden = message === null;
    this.elements.composerInput.setAttribute(
      "aria-invalid",
      String(message !== null),
    );
  }

  setComposerValue(value: string): void {
    this.elements.composerInput.value = value;
    this.elements.composerClearButton.hidden = value.length === 0;
    resizeTextarea(this.elements.composerInput, 7);
  }

  setSearchValue(value: string): void {
    this.elements.searchInput.value = value;
    this.elements.searchClearButton.hidden = value.length === 0;
  }

  setSearchStatus(message: string | null): void {
    this.elements.searchStatus.textContent = message ?? "";
    this.elements.searchStatus.hidden = message === null;
  }

  setHistoryCollapseDraftLocked(locked: boolean): void {
    for (const toggle of this.elements.historyList.querySelectorAll<HTMLButtonElement>(
      'button[data-action="toggle-history-version"]',
    )) {
      updateHistoryToggleLock(toggle, locked);
    }
  }

  renderThoughts(
    thoughts: readonly ThoughtCardView[],
    emptyMessage?: string,
    availableThoughtIds: readonly string[] = thoughts.map((thought) => thought.id),
  ): void {
    const document = this.elements.thoughtList.ownerDocument;
    const available = new Set(availableThoughtIds);
    for (const thoughtId of this.#thoughtCards.keys()) {
      if (!available.has(thoughtId)) this.#thoughtCards.delete(thoughtId);
    }
    const cards = thoughts.map((thought) => {
      let elements = this.#thoughtCards.get(thought.id);
      if (!elements) {
        elements = createThoughtCard(document, thought.id);
        this.#thoughtCards.set(thought.id, elements);
      }
      updateThoughtCard(elements, thought);
      return elements.card;
    });
    this.elements.thoughtList.replaceChildren(...cards);
    for (const thought of thoughts) {
      const elements = this.#thoughtCards.get(thought.id);
      if (elements) resizeTextarea(elements.editor, 1);
    }
    this.elements.listEmpty.textContent =
      emptyMessage ?? "还没有想法。先记录第一条吧。";
    this.elements.listEmpty.hidden = thoughts.length !== 0;
  }

  setHistoryOpen(open: boolean): void {
    const { root, historyPanel } = this.elements;
    const pageWindow = root.ownerDocument.defaultView;

    if (this.#historyCloseTimer !== null && pageWindow) {
      pageWindow.clearTimeout(this.#historyCloseTimer);
      this.#historyCloseTimer = null;
    }

    if (open) {
      const activeElement = root.ownerDocument.activeElement;
      const selectedHistoryButton = root.querySelector<HTMLButtonElement>(
        'button[data-action="toggle-history"][aria-pressed="true"]',
      );
      if (root.classList.contains("history-open") && !historyPanel.hidden) {
        if (selectedHistoryButton)
          this.#historyReturnFocus = selectedHistoryButton;
        return;
      }
      this.#historyReturnFocus =
        selectedHistoryButton ??
        (activeElement instanceof HTMLElement &&
        activeElement.isConnected &&
        !historyPanel.contains(activeElement)
          ? activeElement
          : null);
      historyPanel.hidden = false;
      historyPanel.setAttribute("aria-hidden", "false");
      root.ownerDocument.documentElement.classList.add("ft-history-modal-open");
      this.#setHistoryBackgroundInert(
        this.#mobileHistoryQuery?.matches ?? false,
      );
      void historyPanel.offsetWidth;
      root.classList.add("history-open");
      return;
    }

    const closingThoughtId = historyPanel.dataset.thoughtId;
    if (closingThoughtId) {
      const currentHistoryButton = Array.from(
        root.querySelectorAll<HTMLButtonElement>(
          'button[data-action="toggle-history"]',
        ),
      ).find((button) => button.dataset.thoughtId === closingThoughtId);
      if (currentHistoryButton) this.#historyReturnFocus = currentHistoryButton;
    }
    root.classList.remove("history-open");
    if (historyPanel.hidden) {
      this.#finishHistoryClose(false);
      return;
    }

    const reduceMotion =
      pageWindow?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
      true;
    if (!pageWindow || reduceMotion) {
      this.#finishHistoryClose(true);
      return;
    }
    this.#historyCloseTimer = pageWindow.setTimeout(() => {
      if (!root.classList.contains("history-open"))
        this.#finishHistoryClose(true);
      this.#historyCloseTimer = null;
    }, HISTORY_TRANSITION_MS);
  }

  renderHistory(history: ThoughtHistoryView | null): void {
    const document = this.elements.historyList.ownerDocument;
    if (history === null) {
      this.elements.historyPanel.dataset.thoughtId = "";
      if (this.elements.historyPanel.hidden) {
        this.elements.historyList.replaceChildren();
        this.elements.historyEmpty.hidden = false;
      } else {
        this.elements.historyEmpty.hidden = true;
      }
      return;
    }
    const versions = history.versions.map((version) =>
      createHistoryVersion(document, history.thoughtId, version),
    );
    this.elements.historyPanel.dataset.thoughtId = history.thoughtId;
    this.elements.historyList.replaceChildren(...versions);
    this.elements.historyEmpty.hidden = history.versions.length !== 0;
  }

  showMessage(
    message: string,
    tone: MessageTone = "normal",
    duration = 4200,
  ): void {
    if (this.#toastTimer !== null) {
      window.clearTimeout(this.#toastTimer);
    }
    this.elements.toast.textContent = message;
    this.elements.toast.dataset.tone = tone;
    this.elements.toast.hidden = false;
    this.#toastTimer = window.setTimeout(() => {
      this.elements.toast.hidden = true;
      this.#toastTimer = null;
    }, duration);
  }

  choose(
    title: string,
    message: string,
    choices: readonly DialogChoice[],
  ): Promise<string> {
    if (this.#dialog.open) {
      this.#dialogResolve?.("cancel");
      this.#dialogResolve = null;
      this.#dialog.close();
    }
    this.#dialogTitle.textContent = title;
    this.#dialogMessage.textContent = message;
    this.#dialogActions.replaceChildren();

    return new Promise((resolve) => {
      this.#dialogResolve = resolve;
      for (const choice of choices) {
        const choiceButton = createButton(
          this.#dialog.ownerDocument,
          choice.label,
          choice.label,
          `ft-dialog-button ${choice.tone ?? "neutral"}`,
        );
        choiceButton.dataset.choice = choice.id;
        choiceButton.addEventListener("click", () =>
          this.#resolveDialog(choice.id),
        );
        this.#dialogActions.append(choiceButton);
      }
      this.#dialog.showModal();
    });
  }

  dispose(): void {
    if (this.#toastTimer !== null) {
      window.clearTimeout(this.#toastTimer);
      this.#toastTimer = null;
    }
    if (this.#historyCloseTimer !== null) {
      this.elements.root.ownerDocument.defaultView?.clearTimeout(
        this.#historyCloseTimer,
      );
      this.#historyCloseTimer = null;
    }
    this.elements.root.ownerDocument.documentElement.classList.remove(
      "ft-history-modal-open",
    );
    this.#mobileHistoryQuery?.removeEventListener(
      "change",
      this.#onMobileHistoryChange,
    );
    this.#mobileHistoryQuery = null;
    this.#setHistoryBackgroundInert(false);
    this.#historyReturnFocus = null;
    if (this.#dialog.open) this.#dialog.close();
    this.#dialogResolve?.("cancel");
    this.#dialogResolve = null;
  }

  #resolveDialog(choice: string): void {
    const resolve = this.#dialogResolve;
    if (resolve === null) return;
    this.#dialogResolve = null;
    if (this.#dialog.open) this.#dialog.close();
    resolve(choice);
  }

  #finishHistoryClose(restoreFocus: boolean): void {
    const { historyPanel } = this.elements;
    historyPanel.hidden = true;
    historyPanel.setAttribute("aria-hidden", "true");
    historyPanel.ownerDocument.documentElement.classList.remove(
      "ft-history-modal-open",
    );
    this.#setHistoryBackgroundInert(false);
    if (
      restoreFocus &&
      this.#historyReturnFocus?.isConnected &&
      !this.#historyReturnFocus.inert
    ) {
      this.#historyReturnFocus.focus();
    }
    this.#historyReturnFocus = null;
  }

  #setHistoryBackgroundInert(inert: boolean): void {
    this.#pageHeader.inert = inert;
    this.#primaryColumn.inert = inert;
    this.#draftNotice.inert = inert;
  }
}

export function renderSafeStartupFailure(appRoot: HTMLElement): void {
  const document = appRoot.ownerDocument;
  const failure = document.createElement("main");
  failure.className = "ft-startup-error";
  const title = document.createElement("h1");
  title.textContent = "暂时无法打开碎片想法";
  const message = document.createElement("p");
  message.textContent = "页面没有正常启动。请稍后刷新重试，或先返回首页。";
  const home = document.createElement("a");
  home.href = new URL(import.meta.env.BASE_URL, document.location.href).href;
  home.textContent = "返回首页";
  failure.append(title, message, home);
  appRoot.replaceChildren(failure);
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function createThoughtCard(
  document: Document,
  thoughtId: string,
): ThoughtCardElements {
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
  editor.addEventListener("input", () => resizeTextarea(editor, 1));
  textRegion.append(highlight, editor);

  const error = document.createElement("p");
  error.id = `${editorId}-error`;
  error.className = "ft-field-error";
  error.setAttribute("role", "alert");
  editor.setAttribute("aria-describedby", error.id);

  const historyMatch = createActionButton(
    document,
    "历史命中",
    "open-history-match",
    thoughtId,
    "ft-history-match",
    HistoryIcon,
  );
  historyMatch.title = "打开历史并查看匹配内容";

  const footer = document.createElement("footer");
  footer.className = "ft-card-footer";
  const modified = document.createElement("time");
  modified.className = "ft-modified-time";
  const actions = document.createElement("div");
  actions.className = "ft-card-actions";
  const remove = createActionButton(
    document,
    "删除",
    "delete-thought",
    thoughtId,
    "ft-card-button ft-card-button-danger",
    Delete,
    true,
    "删除这条想法",
  );
  const edit = createActionButton(
    document,
    "编辑",
    "edit-thought",
    thoughtId,
    "ft-card-button",
    Edit,
    true,
    "编辑这条想法",
  );
  const history = createActionButton(
    document,
    "历史",
    "toggle-history",
    thoughtId,
    "ft-card-button",
    HistoryIcon,
    true,
    "查看这条想法的修改记录",
  );
  const cancel = createActionButton(
    document,
    "取消",
    "cancel-edit",
    thoughtId,
    "ft-card-button",
    CloseSmall,
    true,
    "取消这次编辑",
  );
  const save = createActionButton(
    document,
    "保存修改",
    "save-edit",
    thoughtId,
    "ft-card-button ft-card-button-primary",
    Save,
    true,
    "保存这次编辑",
  );
  actions.append(remove, edit, history, cancel, save);
  footer.append(modified, actions);
  card.append(editorLabel, textRegion, error, historyMatch, footer);
  return {
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
  };
}

function updateThoughtCard(
  elements: ThoughtCardElements,
  thought: ThoughtCardView,
): void {
  const editing = thought.editing === true;
  const editorValue = editing ? thought.editDraft ?? thought.content : thought.content;
  elements.card.classList.toggle("is-editing", editing);
  elements.card.classList.toggle("history-selected", thought.historyOpen === true);
  elements.editorLabel.textContent = editing ? "编辑想法内容" : "想法内容";
  if (elements.editor.value !== editorValue) elements.editor.value = editorValue;
  elements.editor.readOnly = !editing;
  elements.editor.tabIndex = editing ? 0 : -1;
  elements.editor.setAttribute("aria-invalid", String(Boolean(thought.editError)));

  elements.highlight.replaceChildren();
  appendHighlightedText(
    elements.highlight,
    thought.content,
    thought.highlightQuery ?? "",
  );
  const showHighlight =
    !editing && elements.highlight.querySelector("mark") !== null;
  elements.highlight.hidden = !showHighlight;
  elements.card.classList.toggle("has-highlight-mirror", showHighlight);

  elements.error.textContent = thought.editError ?? "";
  elements.error.hidden = !thought.editError;

  const historyMatchCount = thought.historyMatchCount ?? 0;
  elements.historyMatch.hidden = editing || historyMatchCount === 0;
  elements.historyMatch.setAttribute(
    "aria-label",
    `历史命中 ${historyMatchCount} 版`,
  );
  const historyMatchLabel = elements.historyMatch.querySelector(".ft-button-label");
  if (historyMatchLabel) historyMatchLabel.textContent = `历史命中 ${historyMatchCount} 版`;

  elements.modified.dateTime = thought.modifiedAt;
  elements.modified.title = thought.modifiedAt;
  elements.modified.textContent = `上次修改：${formatTimestamp(thought.modifiedAt)}`;

  elements.remove.hidden = editing;
  elements.edit.hidden = editing;
  elements.history.hidden = editing;
  elements.cancel.hidden = !editing;
  elements.save.hidden = !editing;
  elements.remove.disabled = thought.mutationsDisabled === true;
  elements.edit.disabled = thought.mutationsDisabled === true;
  elements.history.setAttribute("aria-pressed", String(thought.historyOpen === true));
}

function createHistoryVersion(
  document: Document,
  thoughtId: string,
  version: ThoughtHistoryVersionView,
): HTMLElement {
  const item = document.createElement("section");
  item.className = "ft-history-version";
  item.dataset.versionId = version.id;

  const heading = document.createElement("h3");
  const toggle = createActionButton(
    document,
    formatTimestamp(version.createdAt),
    "toggle-history-version",
    thoughtId,
    "ft-history-version-toggle",
  );
  toggle.dataset.versionId = version.id;
  toggle.setAttribute("aria-expanded", String(version.collapsed !== true));
  toggle.dataset.defaultTitle = version.createdAt;
  if (version.collapseLockedMessage) {
    toggle.dataset.searchLockedMessage = version.collapseLockedMessage;
  }
  updateHistoryToggleLock(toggle, false);
  const marker = createIcon(document, Down, "ft-history-chevron");
  toggle.append(marker);
  heading.append(toggle);

  const content = document.createElement("p");
  content.className = "ft-history-content";
  content.hidden = version.collapsed === true;
  appendHighlightedText(content, version.content, version.highlightQuery ?? "");
  item.append(heading, content);
  return item;
}

function createButton(
  document: Document,
  text: string,
  title: string,
  className: string,
  icon?: IconRenderer,
  iconOnly = false,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.classList.toggle("ft-icon-only", iconOnly);
  if (icon) element.append(createIcon(document, icon));
  if (iconOnly) {
    element.setAttribute("aria-label", title);
  } else {
    const label = document.createElement("span");
    label.className = "ft-button-label";
    label.textContent = text;
    element.append(label);
  }
  element.title = title;
  return element;
}

function createActionButton(
  document: Document,
  text: string,
  action: string,
  thoughtId: string,
  className: string,
  icon?: IconRenderer,
  iconOnly = false,
  accessibleTitle = text,
): HTMLButtonElement {
  const element = createButton(
    document,
    text,
    accessibleTitle,
    className,
    icon,
    iconOnly,
  );
  element.dataset.action = action;
  element.dataset.thoughtId = thoughtId;
  return element;
}

function createIcon(
  document: Document,
  renderer: IconRenderer,
  className?: string,
): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = renderer({
    size: 20,
    strokeWidth: 3,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    theme: "outline",
    fill: "currentColor",
  }).replace(/^<\?xml[^>]*>\s*/u, "");
  const icon = template.content.querySelector("svg");
  if (!icon) throw new Error("IconPark did not return an SVG element.");
  icon.classList.add("ft-icon");
  if (className) icon.classList.add(className);
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
}

function updateHistoryToggleLock(
  toggle: HTMLButtonElement,
  draftLocked: boolean,
): void {
  const lockedMessage = draftLocked
    ? "请先保存、清空或取消当前草稿，再修改折叠状态。"
    : toggle.dataset.searchLockedMessage;
  if (lockedMessage) {
    toggle.setAttribute("aria-disabled", "true");
    toggle.dataset.lockedMessage = lockedMessage;
    toggle.title = lockedMessage;
    return;
  }
  toggle.removeAttribute("aria-disabled");
  delete toggle.dataset.lockedMessage;
  toggle.title = toggle.dataset.defaultTitle ?? "";
}

function appendHighlightedText(
  parent: HTMLElement,
  text: string,
  query: string,
): void {
  if (query.length === 0) {
    parent.textContent = text;
    return;
  }
  const matcher = new RegExp(escapeRegExp(query), "giu");
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index;
    const value = match[0];
    if (index === undefined || value.length === 0) continue;
    parent.append(text.slice(cursor, index));
    const mark = parent.ownerDocument.createElement("mark");
    mark.textContent = value;
    parent.append(mark);
    cursor = index + value.length;
  }
  parent.append(text.slice(cursor));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function resizeTextarea(textarea: HTMLTextAreaElement, minimum: number): void {
  textarea.rows = minimum;
  textarea.style.height = "auto";
  const pageWindow = textarea.ownerDocument.defaultView;
  const styles = pageWindow?.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles?.lineHeight ?? "") || 24;
  const verticalPadding =
    (Number.parseFloat(styles?.paddingTop ?? "") || 0) +
    (Number.parseFloat(styles?.paddingBottom ?? "") || 0);
  const verticalBorder =
    (Number.parseFloat(styles?.borderTopWidth ?? "") || 0) +
    (Number.parseFloat(styles?.borderBottomWidth ?? "") || 0);
  const minimumHeight = lineHeight * minimum + verticalPadding + verticalBorder;
  textarea.style.height = `${Math.max(textarea.scrollHeight, minimumHeight)}px`;
}
