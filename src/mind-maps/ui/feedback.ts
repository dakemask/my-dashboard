import type { DialogChoice, MindMapMessageTone } from "./types";

const NORMAL_TOAST_DURATION = 4_200;
const ERROR_TOAST_DURATION = 6_200;

/** Business-only toast and confirmation dialog; Shared sync feedback remains in ModuleSyncUi. */
export class MindMapFeedback {
  readonly toast: HTMLElement;
  readonly #dialog: HTMLDialogElement;
  readonly #dialogTitle: HTMLElement;
  readonly #dialogMessage: HTMLElement;
  readonly #dialogActions: HTMLElement;
  readonly #window: Window;
  #dialogResolve: ((choice: string) => void) | null = null;
  #cancelChoiceId: string | null = null;
  #fallbackChoiceId: string | null = null;
  #returnFocus: HTMLElement | null = null;
  #toastTimer: number | null = null;

  constructor(root: HTMLElement) {
    const document = root.ownerDocument;
    const pageWindow = document.defaultView;
    if (!pageWindow) throw new Error("Mind Map feedback requires a browser window.");
    this.#window = pageWindow;
    const toast = document.createElement("div");
    toast.className = "mind-maps-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.hidden = true;

    const dialog = document.createElement("dialog");
    dialog.className = "mind-maps-dialog";
    dialog.setAttribute("aria-labelledby", "mind-maps-dialog-title");
    dialog.setAttribute("aria-describedby", "mind-maps-dialog-message");
    const surface = document.createElement("div");
    surface.className = "dialog-surface";
    const dialogTitle = document.createElement("h2");
    dialogTitle.className = "dialog-title";
    dialogTitle.id = "mind-maps-dialog-title";
    const dialogMessage = document.createElement("p");
    dialogMessage.className = "dialog-message";
    dialogMessage.id = "mind-maps-dialog-message";
    const dialogActions = document.createElement("div");
    dialogActions.className = "dialog-actions";
    surface.append(dialogTitle, dialogMessage, dialogActions);
    dialog.append(surface);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (this.#cancelChoiceId) this.#finishDialog(this.#cancelChoiceId);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && this.#cancelChoiceId) this.#finishDialog(this.#cancelChoiceId);
    });
    root.append(toast, dialog);

    this.toast = toast;
    this.#dialog = dialog;
    this.#dialogTitle = dialogTitle;
    this.#dialogMessage = dialogMessage;
    this.#dialogActions = dialogActions;
  }

  get dialogOpen(): boolean {
    return this.#dialog.open && this.#dialogResolve !== null;
  }

  showMessage(message: string, tone: MindMapMessageTone = "normal"): void {
    if (this.#toastTimer !== null) this.#window.clearTimeout(this.#toastTimer);
    this.toast.textContent = message;
    this.toast.dataset.tone = tone;
    this.toast.hidden = false;
    const isError = tone === "error";
    this.toast.setAttribute("role", isError ? "alert" : "status");
    this.toast.setAttribute("aria-live", isError ? "assertive" : "polite");
    this.#toastTimer = this.#window.setTimeout(() => {
      this.toast.hidden = true;
      this.#toastTimer = null;
    }, isError ? ERROR_TOAST_DURATION : NORMAL_TOAST_DURATION);
  }

  choose(title: string, message: string, choices: readonly DialogChoice[]): Promise<string> {
    if (choices.length === 0) throw new TypeError("A dialog requires at least one choice.");
    if (this.#dialogResolve) {
      this.#finishDialog(this.#cancelChoiceId ?? this.#fallbackChoiceId ?? "cancel");
    }
    this.#dialogTitle.textContent = title;
    this.#dialogMessage.textContent = message;
    this.#dialogActions.replaceChildren();
    const ordered = orderChoices(choices);
    this.#cancelChoiceId = ordered.find((choice) => choice.id === "cancel")?.id ?? null;
    this.#fallbackChoiceId = ordered[0]!.id;
    const active = this.#dialog.ownerDocument.activeElement;
    this.#returnFocus = active && "focus" in active && typeof active.focus === "function"
      ? active as HTMLElement
      : null;

    return new Promise((resolve) => {
      this.#dialogResolve = resolve;
      let cancelButton: HTMLButtonElement | null = null;
      for (const choice of ordered) {
        const choiceButton = this.#dialog.ownerDocument.createElement("button");
        choiceButton.type = "button";
        choiceButton.className = `dialog-button ${choice.tone ?? "neutral"}`;
        choiceButton.textContent = choice.label;
        choiceButton.addEventListener("click", () => this.#finishDialog(choice.id));
        this.#dialogActions.append(choiceButton);
        if (choice.id === this.#cancelChoiceId) cancelButton = choiceButton;
      }
      this.#dialog.showModal();
      (cancelButton ?? this.#dialogActions.querySelector<HTMLButtonElement>("button"))?.focus();
    });
  }

  dispose(): void {
    if (this.#toastTimer !== null) this.#window.clearTimeout(this.#toastTimer);
    this.#toastTimer = null;
    if (this.#dialogResolve) {
      const choice = this.#cancelChoiceId ?? this.#fallbackChoiceId ?? "cancel";
      this.#finishDialog(choice);
    } else if (this.#dialog.open) {
      this.#dialog.close();
    }
  }

  #finishDialog(choice: string): void {
    const resolve = this.#dialogResolve;
    if (!resolve) return;
    this.#dialogResolve = null;
    this.#cancelChoiceId = null;
    this.#fallbackChoiceId = null;
    if (this.#dialog.open) this.#dialog.close();
    resolve(choice);
    const returnFocus = this.#returnFocus;
    this.#returnFocus = null;
    this.#window.queueMicrotask(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  }
}

function orderChoices(choices: readonly DialogChoice[]): readonly DialogChoice[] {
  return [
    ...choices.filter((choice) => choice.id === "cancel"),
    ...choices.filter((choice) => choice.id !== "cancel" && choice.tone !== "danger"),
    ...choices.filter((choice) => choice.id !== "cancel" && choice.tone === "danger"),
  ];
}
