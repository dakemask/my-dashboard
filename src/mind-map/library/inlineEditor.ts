import { CloseSmall } from "@icon-park/svg";
import { createIconOnlyButton } from "../../shared";
import {
  createLibraryRowChrome,
  updateLibraryRowChrome,
  type LibraryRowChrome,
  type LibraryRowKind,
} from "./rowChrome";
import type { LibraryDraft } from "./types";

export interface LibraryInlineEditorState {
  readonly kind: LibraryRowKind;
  readonly expanded?: boolean;
  readonly selected: boolean;
  readonly current: boolean;
  readonly dirty: boolean;
}

export interface LibraryInlineEditorCallbacks {
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}

/** Owns only the transient name editor; business validation remains in the facade callbacks. */
export class LibraryInlineEditor {
  readonly draft: LibraryDraft;
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  readonly error: HTMLElement;
  readonly #chrome: LibraryRowChrome;
  readonly #callbacks: LibraryInlineEditorCallbacks;
  #composing = false;

  constructor(
    document: Document,
    draft: LibraryDraft,
    value: string,
    state: LibraryInlineEditorState,
    callbacks: LibraryInlineEditorCallbacks,
  ) {
    this.draft = draft;
    this.#callbacks = callbacks;
    const element = document.createElement("div");
    element.className = "library-inline-editor";
    element.classList.toggle("is-rename", draft.kind === "rename");
    const chrome = createLibraryRowChrome(document, element);

    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.setAttribute("aria-label", draft.kind === "rename" ? "新名称" : "项目名称");
    chrome.nameSlot.replaceChildren(input);

    const cancelLabel = draft.kind === "rename" ? "取消重命名" : "取消新建项目";
    const cancel = createIconOnlyButton(document, CloseSmall, cancelLabel, {
      classNames: "inline-cancel",
      iconClassNames: "mind-map-icon",
      iconSize: 16,
    });
    // Keep the input focused until click so its blur handler cannot commit before cancel.
    cancel.addEventListener("pointerdown", (event) => event.preventDefault());
    cancel.addEventListener("click", () => this.#callbacks.onCancel());

    const error = document.createElement("span");
    error.className = "inline-error";
    error.setAttribute("role", "alert");
    element.append(cancel, error);

    input.addEventListener("compositionstart", () => { this.#composing = true; });
    input.addEventListener("compositionend", () => { this.#composing = false; });
    input.addEventListener("input", () => this.clearError());
    input.addEventListener("keydown", (event) => {
      // Escape intentionally stays native and bubbles; only the explicit button cancels.
      if (
        event.key !== "Enter"
        || this.#composing
        || event.isComposing
        || event.keyCode === 229
        || event.ctrlKey
        || event.altKey
        || event.metaKey
        || event.shiftKey
      ) return;
      event.preventDefault();
      this.#callbacks.onCommit(input.value);
    });
    input.addEventListener("blur", () => this.#callbacks.onCommit(input.value));

    this.element = element;
    this.input = input;
    this.error = error;
    this.#chrome = chrome;
    this.update(state);
  }

  update(state: LibraryInlineEditorState): void {
    updateLibraryRowChrome(this.#chrome, state);
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.input.setAttribute("aria-invalid", "true");
  }

  clearError(): void {
    this.error.textContent = "";
    this.input.removeAttribute("aria-invalid");
  }

  focusAndSelect(): void {
    this.input.focus();
    this.input.select();
  }
}
