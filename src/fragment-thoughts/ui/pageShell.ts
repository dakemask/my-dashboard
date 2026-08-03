import {
  CloseSmall,
  Home,
  Save,
  Search,
} from "@icon-park/svg";

import {
  createIconOnlyButton,
  createIconParkIcon,
  type IconParkRenderer,
} from "../../shared";
import type { FragmentThoughtsShellCallbacks } from "./types";

export interface FragmentThoughtsPageShellElements {
  readonly root: HTMLElement;
  readonly pageHeader: HTMLElement;
  readonly homeLink: HTMLAnchorElement;
  readonly syncMount: HTMLElement;
  readonly workspace: HTMLElement;
  readonly primaryColumn: HTMLElement;
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
}

export interface FragmentThoughtsPageShellOptions {
  readonly thoughtList?: HTMLElement;
  readonly listEmpty?: HTMLElement;
}

/** Owns the stable page, composer, and search DOM. */
export class FragmentThoughtsPageShell {
  readonly elements: FragmentThoughtsPageShellElements;

  readonly #removeListeners: Array<() => void> = [];
  #callbacks: FragmentThoughtsShellCallbacks | null = null;

  constructor(
    appRoot: HTMLElement,
    options: FragmentThoughtsPageShellOptions = {},
  ) {
    const document = appRoot.ownerDocument;
    const root = document.createElement("main");
    root.className = "fragment-thoughts-app";

    const pageHeader = document.createElement("header");
    pageHeader.className = "ft-page-header";
    const headerBar = document.createElement("div");
    headerBar.className = "ft-header-bar";

    const identity = document.createElement("div");
    identity.className = "ft-identity";
    const homeLink = document.createElement("a");
    homeLink.className = "ft-home-link ft-icon-only";
    homeLink.href = new URL(import.meta.env.BASE_URL, document.location.href).href;
    homeLink.title = "返回首页";
    homeLink.setAttribute("aria-label", "返回首页");
    homeLink.append(createIconParkIcon(document, Home, {
      classNames: "ft-icon",
    }));

    const titleCopy = document.createElement("div");
    titleCopy.className = "ft-title-copy";
    const eyebrow = document.createElement("p");
    eyebrow.className = "ft-eyebrow";
    eyebrow.textContent = "MY DASHBOARD";
    const titleRow = document.createElement("div");
    titleRow.className = "ft-title-row";
    const title = document.createElement("h1");
    title.textContent = "碎片想法";
    titleRow.append(title);
    const subtitle = document.createElement("p");
    subtitle.className = "ft-subtitle";
    subtitle.textContent = "快速记录你的想法。";
    titleCopy.append(eyebrow, titleRow, subtitle);
    identity.append(homeLink, titleCopy);

    const syncMount = document.createElement("div");
    syncMount.className = "ft-sync-mount";
    headerBar.append(identity, syncMount);
    pageHeader.append(headerBar);

    const workspace = document.createElement("div");
    workspace.className = "ft-workspace";
    const primaryColumn = document.createElement("div");
    primaryColumn.className = "ft-primary-column";

    const composer = document.createElement("section");
    composer.className = "ft-composer";
    composer.setAttribute("aria-labelledby", "fragment-thoughts-composer-title");
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
    composerInput.setAttribute("aria-describedby", "fragment-thoughts-composer-error");
    const composerError = document.createElement("p");
    composerError.id = "fragment-thoughts-composer-error";
    composerError.className = "ft-field-error";
    composerError.setAttribute("role", "alert");
    composerError.hidden = true;
    const composerActions = document.createElement("div");
    composerActions.className = "ft-composer-actions";
    const composerClearButton = createTextButton(
      document,
      "清空",
      "清空当前草稿",
      "ft-button ft-button-subtle",
      CloseSmall,
    );
    composerClearButton.dataset.action = "clear-composer";
    composerClearButton.hidden = true;
    const composerSaveButton = createTextButton(
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
    browseSection.setAttribute("aria-labelledby", "fragment-thoughts-list-title");
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
    const searchInput = document.createElement("input");
    searchInput.id = "fragment-thoughts-search";
    searchInput.type = "search";
    searchInput.placeholder = "搜索想法";
    searchInput.autocomplete = "off";
    const searchClearButton = createIconOnlyButton(
      document,
      CloseSmall,
      "清除搜索内容",
      {
        classNames: "ft-search-clear ft-icon-only",
        iconClassNames: "ft-icon",
      },
    );
    searchClearButton.dataset.action = "clear-search";
    searchClearButton.hidden = true;
    searchWrap.append(
      searchLabel,
      createIconParkIcon(document, Search, {
        classNames: "ft-search-icon",
      }),
      searchInput,
      searchClearButton,
    );
    browseHeading.append(listTitle, searchWrap);
    const searchStatus = document.createElement("p");
    searchStatus.className = "ft-search-status";
    searchStatus.setAttribute("role", "status");
    searchStatus.setAttribute("aria-live", "polite");
    searchStatus.hidden = true;
    const thoughtList = options.thoughtList ?? document.createElement("div");
    thoughtList.classList.add("ft-thought-list");
    const listEmpty = options.listEmpty ?? document.createElement("div");
    listEmpty.classList.add("ft-empty-state");
    if (!listEmpty.textContent) listEmpty.textContent = "还没有想法。先记录第一条吧。";
    listEmpty.hidden = true;
    browseSection.append(browseHeading, searchStatus, thoughtList, listEmpty);

    primaryColumn.append(composer, browseSection);
    workspace.append(primaryColumn);
    root.append(pageHeader, workspace);
    appRoot.replaceChildren(root);

    this.elements = {
      root,
      pageHeader,
      homeLink,
      syncMount,
      workspace,
      primaryColumn,
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
    };

    this.#listen(composerInput, "input", () => {
      composerClearButton.hidden = composerInput.value.length === 0;
      resizeTextarea(composerInput, 7);
      this.#callbacks?.onComposerInput?.(composerInput.value);
    });
    this.#listen(composerForm, "submit", (event) => {
      event.preventDefault();
      this.#callbacks?.onComposerSubmit?.(composerInput.value);
    });
    this.#listen(composerClearButton, "click", () => {
      this.#callbacks?.onComposerClear?.();
    });
    this.#listen(searchInput, "input", () => {
      searchClearButton.hidden = searchInput.value.length === 0;
      this.#callbacks?.onSearchInput?.(searchInput.value);
    });
    this.#listen(searchClearButton, "click", () => {
      this.#callbacks?.onSearchClear?.();
    });
  }

  setCallbacks(callbacks: FragmentThoughtsShellCallbacks | null): void {
    this.#callbacks = callbacks;
  }

  getSyncMount(): HTMLElement {
    return this.elements.syncMount;
  }

  getComposerValue(): string {
    return this.elements.composerInput.value;
  }

  getSearchValue(): string {
    return this.elements.searchInput.value;
  }

  hasComposerDraft(): boolean {
    return this.elements.composerInput.value.length !== 0;
  }

  setComposerValue(value: string): void {
    const { composerInput, composerClearButton } = this.elements;
    if (composerInput.value !== value) composerInput.value = value;
    composerClearButton.hidden = value.length === 0;
    resizeTextarea(composerInput, 7);
  }

  setComposerError(message: string | null): void {
    const { composerError, composerInput } = this.elements;
    composerError.textContent = message ?? "";
    composerError.hidden = message === null;
    composerInput.setAttribute("aria-invalid", String(message !== null));
  }

  setComposerEnabled(enabled: boolean): void {
    const { composerInput, composerClearButton, composerSaveButton } = this.elements;
    composerInput.disabled = !enabled;
    composerClearButton.disabled = !enabled;
    composerSaveButton.disabled = !enabled;
  }

  setSearchValue(value: string): void {
    const { searchInput, searchClearButton } = this.elements;
    if (searchInput.value !== value) searchInput.value = value;
    searchClearButton.hidden = value.length === 0;
  }

  setSearchStatus(message: string | null): void {
    this.elements.searchStatus.textContent = message ?? "";
    this.elements.searchStatus.hidden = message === null;
  }

  focusComposer(): void {
    this.elements.composerInput.focus();
  }

  focusSearch(): void {
    this.elements.searchInput.focus();
  }

  dispose(): void {
    this.#callbacks = null;
    for (const remove of this.#removeListeners.splice(0)) remove();
  }

  #listen(
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
  ): void {
    target.addEventListener(type, listener);
    this.#removeListeners.push(() => target.removeEventListener(type, listener));
  }
}

function createTextButton(
  document: Document,
  label: string,
  title: string,
  className: string,
  icon: IconParkRenderer,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = title;
  button.append(
    createIconParkIcon(document, icon, { classNames: "ft-icon" }),
    createLabel(document, label),
  );
  return button;
}

function createLabel(document: Document, text: string): HTMLSpanElement {
  const label = document.createElement("span");
  label.className = "ft-button-label";
  label.textContent = text;
  return label;
}

function resizeTextarea(textarea: HTMLTextAreaElement, minimum: number): void {
  textarea.rows = minimum;
  textarea.style.height = "auto";
  const styles = textarea.ownerDocument.defaultView?.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles?.lineHeight ?? "") || 24;
  const verticalPadding =
    (Number.parseFloat(styles?.paddingTop ?? "") || 0)
    + (Number.parseFloat(styles?.paddingBottom ?? "") || 0);
  const verticalBorder =
    (Number.parseFloat(styles?.borderTopWidth ?? "") || 0)
    + (Number.parseFloat(styles?.borderBottomWidth ?? "") || 0);
  const minimumHeight = lineHeight * minimum + verticalPadding + verticalBorder;
  textarea.style.height = `${Math.max(textarea.scrollHeight, minimumHeight)}px`;
}
