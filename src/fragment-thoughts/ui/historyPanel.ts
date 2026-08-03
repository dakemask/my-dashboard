import {
  CloseSmall,
  Down,
} from "@icon-park/svg";

import {
  createIconOnlyButton,
  createIconParkIcon,
} from "../../shared";
import type {
  FragmentThoughtsShellCallbacks,
  ThoughtHistoryVersionView,
  ThoughtHistoryView,
} from "./types";
import {
  appendHighlightedRanges,
  findLegacyHighlightRanges,
  formatTimestamp,
} from "./textPresentation";

const HISTORY_TRANSITION_MS = 340;

export interface HistoryPanelElements {
  readonly panel: HTMLElement;
  readonly title: HTMLElement;
  readonly closeButton: HTMLButtonElement;
  readonly list: HTMLElement;
  readonly empty: HTMLElement;
}

export interface HistoryPanelOptions {
  readonly document: Document;
  readonly root: HTMLElement;
  readonly backgroundElements: () => readonly HTMLElement[];
  readonly showLockedMessage: (message: string) => void;
}

interface HistoryVersionElements {
  readonly item: HTMLElement;
  readonly toggle: HTMLButtonElement;
  readonly label: HTMLElement;
  readonly content: HTMLElement;
}

/** Owns history rendering, responsive drawer semantics, and focus restoration. */
export class HistoryPanel {
  readonly elements: HistoryPanelElements;

  readonly #root: HTMLElement;
  readonly #backgroundElements: () => readonly HTMLElement[];
  readonly #showLockedMessage: (message: string) => void;
  readonly #removeListeners: Array<() => void> = [];
  readonly #versions = new Map<string, HistoryVersionElements>();
  readonly #onMobileHistoryChange = (event: MediaQueryListEvent): void => {
    if (this.#root.classList.contains("history-open")) {
      this.#setBackgroundInert(event.matches);
    }
  };
  #callbacks: FragmentThoughtsShellCallbacks | null = null;
  #closeTimer: number | null = null;
  #draftLocked = false;
  #returnFocus: HTMLElement | null = null;
  #mobileQuery: MediaQueryList | null;

  constructor(options: HistoryPanelOptions) {
    this.#root = options.root;
    this.#backgroundElements = options.backgroundElements;
    this.#showLockedMessage = options.showLockedMessage;
    const { document } = options;

    const panel = document.createElement("aside");
    panel.className = "ft-history-panel";
    panel.setAttribute("aria-label", "修改记录");
    panel.setAttribute("aria-hidden", "true");
    panel.hidden = true;
    const header = document.createElement("header");
    header.className = "ft-history-header";
    const headingGroup = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = "修改记录";
    headingGroup.append(title);
    const closeButton = createIconOnlyButton(
      document,
      CloseSmall,
      "关闭历史记录",
      {
        classNames: "ft-icon-button ft-icon-only",
        iconClassNames: "ft-icon",
      },
    );
    closeButton.dataset.action = "close-history";
    header.append(headingGroup, closeButton);
    const list = document.createElement("div");
    list.className = "ft-history-list";
    const empty = document.createElement("div");
    empty.className = "ft-empty-state ft-history-empty";
    empty.textContent = "这条想法暂无历史记录。";
    empty.hidden = true;
    panel.append(header, list, empty);
    this.elements = { panel, title, closeButton, list, empty };

    this.#mobileQuery =
      document.defaultView?.matchMedia?.("(max-width: 820px)") ?? null;
    this.#mobileQuery?.addEventListener("change", this.#onMobileHistoryChange);
    this.#listen(closeButton, "click", () => {
      this.#callbacks?.onCloseHistory?.();
    });
    this.#listen(list, "click", (event) => {
      const target = event.target;
      const ElementConstructor = list.ownerDocument.defaultView?.Element;
      if (!ElementConstructor || !(target instanceof ElementConstructor)) return;
      const toggle = target.closest<HTMLButtonElement>(
        'button[data-action="toggle-history-version"]',
      );
      if (!toggle || !list.contains(toggle)) return;
      const lockedMessage = toggle.dataset.lockedMessage;
      if (lockedMessage) {
        this.#showLockedMessage(lockedMessage);
        return;
      }
      const thoughtId = toggle.dataset.thoughtId;
      const versionId = toggle.dataset.versionId;
      if (thoughtId && versionId) {
        this.#callbacks?.onToggleHistoryVersion?.(thoughtId, versionId);
      }
    });
  }

  setCallbacks(callbacks: FragmentThoughtsShellCallbacks | null): void {
    this.#callbacks = callbacks;
  }

  setOpen(open: boolean): void {
    const { panel } = this.elements;
    const document = panel.ownerDocument;
    const pageWindow = document.defaultView;
    const active = document.activeElement;
    const HTMLElementConstructor = pageWindow?.HTMLElement;
    const activeOutsidePanel = HTMLElementConstructor
      && active instanceof HTMLElementConstructor
      && active.isConnected
      && !panel.contains(active)
      ? active
      : null;

    if (this.#closeTimer !== null && pageWindow) {
      pageWindow.clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }

    if (open) {
      if (activeOutsidePanel) this.#returnFocus = activeOutsidePanel;
      if (this.#root.classList.contains("history-open") && !panel.hidden) return;
      panel.hidden = false;
      panel.setAttribute("aria-hidden", "false");
      document.documentElement.classList.add("ft-history-modal-open");
      this.#setBackgroundInert(this.#mobileQuery?.matches ?? false);
      void panel.offsetWidth;
      this.#root.classList.add("history-open");
      return;
    }

    if (activeOutsidePanel) this.#returnFocus = activeOutsidePanel;
    this.#root.classList.remove("history-open");
    if (panel.hidden) {
      this.#finishClose(false);
      return;
    }
    const reduceMotion =
      pageWindow?.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ?? true;
    if (!pageWindow || reduceMotion) {
      this.#finishClose(true);
      return;
    }
    this.#closeTimer = pageWindow.setTimeout(() => {
      if (!this.#root.classList.contains("history-open")) this.#finishClose(true);
      this.#closeTimer = null;
    }, HISTORY_TRANSITION_MS);
  }

  render(history: ThoughtHistoryView | null): void {
    const { panel, list, empty } = this.elements;
    if (history === null) {
      panel.dataset.thoughtId = "";
      if (panel.hidden) {
        this.#clearVersions();
        empty.hidden = false;
      } else {
        empty.hidden = true;
      }
      return;
    }
    panel.dataset.thoughtId = history.thoughtId;
    const available = new Set(history.versions.map(({ id }) => id));
    for (const [versionId, elements] of this.#versions) {
      if (available.has(versionId)) continue;
      elements.item.remove();
      this.#versions.delete(versionId);
    }
    let reference = list.firstElementChild;
    for (const version of history.versions) {
      let elements = this.#versions.get(version.id);
      if (!elements) {
        elements = createHistoryVersion(list.ownerDocument, version.id);
        this.#versions.set(version.id, elements);
      }
      updateHistoryVersion(
        elements,
        history.thoughtId,
        version,
        this.#draftLocked,
      );
      if (elements.item !== reference) list.insertBefore(elements.item, reference);
      reference = elements.item.nextElementSibling;
    }
    empty.hidden = history.versions.length !== 0;
  }

  setDraftLocked(locked: boolean): void {
    this.#draftLocked = locked;
    for (const toggle of this.elements.list.querySelectorAll<HTMLButtonElement>(
      'button[data-action="toggle-history-version"]',
    )) {
      updateToggleLock(toggle, locked);
    }
  }

  focusClose(): void {
    this.elements.closeButton.focus();
  }

  dispose(): void {
    const pageWindow = this.elements.panel.ownerDocument.defaultView;
    if (this.#closeTimer !== null) {
      pageWindow?.clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    this.#callbacks = null;
    this.#root.classList.remove("history-open");
    this.elements.panel.ownerDocument.documentElement.classList.remove(
      "ft-history-modal-open",
    );
    this.#mobileQuery?.removeEventListener("change", this.#onMobileHistoryChange);
    this.#mobileQuery = null;
    this.#setBackgroundInert(false);
    this.#returnFocus = null;
    this.#clearVersions();
    for (const remove of this.#removeListeners.splice(0)) remove();
  }

  #finishClose(restoreFocus: boolean): void {
    const { panel } = this.elements;
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    panel.ownerDocument.documentElement.classList.remove("ft-history-modal-open");
    this.#setBackgroundInert(false);
    if (!panel.dataset.thoughtId) this.#clearVersions();
    if (
      restoreFocus
      && this.#returnFocus?.isConnected
      && !this.#returnFocus.inert
    ) {
      this.#returnFocus.focus();
    }
    this.#returnFocus = null;
  }

  #setBackgroundInert(inert: boolean): void {
    for (const element of this.#backgroundElements()) element.inert = inert;
  }

  #clearVersions(): void {
    this.#versions.clear();
    this.elements.list.replaceChildren();
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

function createHistoryVersion(
  document: Document,
  versionId: string,
): HistoryVersionElements {
  const item = document.createElement("section");
  item.className = "ft-history-version";
  item.dataset.versionId = versionId;
  const heading = document.createElement("h3");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ft-history-version-toggle";
  toggle.dataset.action = "toggle-history-version";
  const label = document.createElement("span");
  label.className = "ft-button-label";
  toggle.append(
    label,
    createIconParkIcon(document, Down, {
      classNames: "ft-icon ft-history-chevron",
    }),
  );
  heading.append(toggle);

  const content = document.createElement("p");
  content.className = "ft-history-content";
  item.append(heading, content);
  return { item, toggle, label, content };
}

function updateHistoryVersion(
  elements: HistoryVersionElements,
  thoughtId: string,
  version: ThoughtHistoryVersionView,
  draftLocked: boolean,
): void {
  elements.toggle.dataset.thoughtId = thoughtId;
  elements.toggle.dataset.versionId = version.id;
  elements.toggle.dataset.defaultTitle = version.createdAt;
  elements.toggle.setAttribute("aria-expanded", String(version.collapsed !== true));
  if (version.collapseLockedMessage) {
    elements.toggle.dataset.searchLockedMessage = version.collapseLockedMessage;
  } else {
    delete elements.toggle.dataset.searchLockedMessage;
  }
  elements.label.textContent = formatTimestamp(version.createdAt);
  elements.content.hidden = version.collapsed === true;
  appendHighlightedRanges(
    elements.content,
    version.content,
    version.highlightRanges
      ?? findLegacyHighlightRanges(version.content, version.highlightQuery ?? ""),
  );
  updateToggleLock(elements.toggle, draftLocked);
}

function updateToggleLock(toggle: HTMLButtonElement, draftLocked: boolean): void {
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
