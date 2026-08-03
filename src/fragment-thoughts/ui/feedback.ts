import type {
  DialogChoice,
  FragmentThoughtsShellCallbacks,
  MessageTone,
} from "./types";

export interface FragmentThoughtsFeedbackElements {
  readonly saveFailure: HTMLElement;
  readonly retrySaveButton: HTMLButtonElement;
  readonly draftNotice: HTMLElement;
  readonly toast: HTMLElement;
  readonly dialog: HTMLDialogElement;
}

/** Owns persistent save feedback, transient messages, and confirmations. */
export class FragmentThoughtsFeedback {
  readonly elements: FragmentThoughtsFeedbackElements;

  readonly #dialogTitle: HTMLElement;
  readonly #dialogMessage: HTMLElement;
  readonly #dialogActions: HTMLElement;
  readonly #removeListeners: Array<() => void> = [];
  #callbacks: FragmentThoughtsShellCallbacks | null = null;
  #dialogResolve: ((choice: string) => void) | null = null;
  #dialogReturnFocus: HTMLElement | null = null;
  #toastTimer: number | null = null;

  constructor(document: Document) {
    const saveFailure = document.createElement("div");
    saveFailure.className = "ft-save-failure";
    saveFailure.setAttribute("role", "alert");
    saveFailure.hidden = true;
    const saveFailureText = document.createElement("span");
    saveFailureText.textContent = "自动保存失败，当前页面内容仍然保留。";
    const retrySaveButton = document.createElement("button");
    retrySaveButton.type = "button";
    retrySaveButton.className = "ft-text-button";
    retrySaveButton.dataset.action = "retry-save";
    retrySaveButton.title = "重新保存到本机";
    retrySaveButton.textContent = "重试保存";
    saveFailure.append(saveFailureText, retrySaveButton);

    const draftNotice = document.createElement("div");
    draftNotice.className = "ft-draft-notice";
    draftNotice.setAttribute("role", "status");
    draftNotice.setAttribute("aria-live", "polite");
    draftNotice.hidden = true;

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

    this.elements = {
      saveFailure,
      retrySaveButton,
      draftNotice,
      toast,
      dialog,
    };
    this.#dialogTitle = dialogTitle;
    this.#dialogMessage = dialogMessage;
    this.#dialogActions = dialogActions;

    this.#listen(retrySaveButton, "click", () => {
      this.#callbacks?.onRetrySave?.();
    });
    this.#listen(dialog, "cancel", (event) => {
      event.preventDefault();
      this.#resolveDialog("cancel");
    });
    this.#listen(dialog, "click", (event) => {
      if (isBackdropClick(dialog, event)) this.#resolveDialog("cancel");
    });
    this.#listen(dialog, "close", () => {
      if (this.#dialogResolve) this.#finishDialog("cancel");
      this.#restoreDialogFocus();
    });
  }

  setCallbacks(callbacks: FragmentThoughtsShellCallbacks | null): void {
    this.#callbacks = callbacks;
  }

  setSaveFailure(message: string | null): void {
    const text = this.elements.saveFailure.firstElementChild;
    if (text) {
      text.textContent = message ?? "自动保存失败，当前页面内容仍然保留。";
    }
    this.elements.saveFailure.hidden = message === null;
  }

  setDraftNotice(message: string | null): void {
    this.elements.draftNotice.textContent = message ?? "";
    this.elements.draftNotice.hidden = message === null;
  }

  showMessage(
    message: string,
    tone: MessageTone = "normal",
    duration?: number,
  ): void {
    const pageWindow = this.elements.toast.ownerDocument.defaultView;
    if (this.#toastTimer !== null) {
      pageWindow?.clearTimeout(this.#toastTimer);
    }
    const error = tone === "error";
    this.elements.toast.textContent = message;
    this.elements.toast.dataset.tone = tone;
    this.elements.toast.setAttribute("role", error ? "alert" : "status");
    this.elements.toast.setAttribute("aria-live", error ? "assertive" : "polite");
    this.elements.toast.hidden = false;
    this.#toastTimer = pageWindow?.setTimeout(() => {
      this.elements.toast.hidden = true;
      this.#toastTimer = null;
    }, duration ?? (error ? 6200 : 4200)) ?? null;
  }

  choose(
    title: string,
    message: string,
    choices: readonly DialogChoice[],
  ): Promise<string> {
    if (choices.length === 0) {
      throw new TypeError("A confirmation dialog requires at least one choice.");
    }
    if (this.#dialogResolve) this.#finishDialog("cancel");
    if (this.elements.dialog.open) this.elements.dialog.close();

    const active = this.elements.dialog.ownerDocument.activeElement;
    const HTMLElementConstructor =
      this.elements.dialog.ownerDocument.defaultView?.HTMLElement;
    this.#dialogReturnFocus = HTMLElementConstructor
      && active instanceof HTMLElementConstructor
      && active.isConnected
      ? active
      : null;
    this.#dialogTitle.textContent = title;
    this.#dialogMessage.textContent = message;
    this.#dialogActions.replaceChildren();
    const orderedChoices = [...choices].sort((left, right) =>
      choiceRank(left) - choiceRank(right));

    return new Promise((resolve) => {
      this.#dialogResolve = resolve;
      const buttons = orderedChoices.map((choice) => {
        const button = this.elements.dialog.ownerDocument.createElement("button");
        button.type = "button";
        button.className = `ft-dialog-button ${choice.tone ?? "neutral"}`;
        button.dataset.choice = choice.id;
        button.title = choice.label;
        button.textContent = choice.label;
        button.addEventListener("click", () => this.#resolveDialog(choice.id), {
          once: true,
        });
        return button;
      });
      this.#dialogActions.append(...buttons);
      this.elements.dialog.showModal();
      const initial = buttons.find((button) => button.dataset.choice === "cancel")
        ?? buttons[0];
      initial?.focus();
    });
  }

  dispose(): void {
    const pageWindow = this.elements.toast.ownerDocument.defaultView;
    if (this.#toastTimer !== null) {
      pageWindow?.clearTimeout(this.#toastTimer);
      this.#toastTimer = null;
    }
    this.#callbacks = null;
    if (this.#dialogResolve) this.#finishDialog("cancel");
    if (this.elements.dialog.open) this.elements.dialog.close();
    this.#dialogReturnFocus = null;
    for (const remove of this.#removeListeners.splice(0)) remove();
  }

  #resolveDialog(choice: string): void {
    if (!this.#dialogResolve) return;
    this.#finishDialog(choice);
    if (this.elements.dialog.open) this.elements.dialog.close();
    this.#restoreDialogFocus();
  }

  #finishDialog(choice: string): void {
    const resolve = this.#dialogResolve;
    this.#dialogResolve = null;
    resolve?.(choice);
  }

  #restoreDialogFocus(): void {
    if (this.#dialogReturnFocus?.isConnected) this.#dialogReturnFocus.focus();
    this.#dialogReturnFocus = null;
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

function choiceRank(choice: DialogChoice): number {
  if (choice.id === "cancel") return 0;
  if (choice.tone === "danger") return 2;
  return 1;
}

function isBackdropClick(dialog: HTMLDialogElement, event: Event): boolean {
  if (event.target !== dialog) return false;
  const MouseEventConstructor = dialog.ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor || !(event instanceof MouseEventConstructor)) return false;
  const bounds = dialog.getBoundingClientRect();
  return event.clientX < bounds.left
    || event.clientX > bounds.right
    || event.clientY < bounds.top
    || event.clientY > bounds.bottom;
}
