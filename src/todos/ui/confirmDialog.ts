import { textButton } from "./shell";

export interface TodoConfirmationOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly trigger?: HTMLElement | null;
  readonly canCancel?: () => boolean;
  readonly destructive?: boolean;
}

interface ActiveConfirmation {
  readonly dialog: HTMLDialogElement;
  readonly trigger: HTMLElement | null;
  readonly resolve: (confirmed: boolean) => void;
}

let confirmationId = 0;

export class TodoConfirmDialog {
  readonly #document: Document;
  readonly #mount: HTMLElement;
  #active: ActiveConfirmation | null = null;
  #disposed = false;

  constructor(document: Document, mount: HTMLElement) {
    this.#document = document;
    this.#mount = mount;
  }

  confirm(options: TodoConfirmationOptions): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    if (this.#active) throw new Error("A Todo confirmation dialog is already open.");

    const dialog = this.#document.createElement("dialog");
    dialog.className = "todo-confirm-dialog";
    const panel = this.#document.createElement("div");
    panel.className = "todo-dialog-panel";
    const id = ++confirmationId;
    const title = this.#document.createElement("h2");
    title.id = `todo-confirm-title-${id}`;
    title.textContent = options.title;
    const message = this.#document.createElement("p");
    message.id = `todo-confirm-message-${id}`;
    message.textContent = options.message;
    dialog.setAttribute("aria-labelledby", title.id);
    dialog.setAttribute("aria-describedby", message.id);

    const actions = this.#document.createElement("div");
    actions.className = "todo-confirm-actions";
    const cancel = textButton(
      this.#document,
      options.cancelLabel ?? "取消",
      "todos-button subtle",
    );
    const confirm = textButton(
      this.#document,
      options.confirmLabel,
      `todos-button ${options.destructive === false ? "primary" : "danger"}`,
    );
    actions.append(cancel, confirm);
    panel.append(title, message, actions);
    dialog.append(panel);
    this.#mount.append(dialog);

    const trigger = options.trigger ?? activeHTMLElement(this.#document);
    const canCancel = options.canCancel ?? (() => true);
    const promise = new Promise<boolean>((resolve) => {
      this.#active = { dialog, trigger, resolve };
    });
    const finish = (confirmed: boolean): void => this.#finish(dialog, confirmed);
    const cancelSafely = (): void => {
      if (canCancel()) finish(false);
    };

    cancel.addEventListener("click", cancelSafely);
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelSafely();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) cancelSafely();
    });

    showModal(dialog);
    cancel.focus();
    return promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const active = this.#active;
    if (active) this.#finish(active.dialog, false, false);
  }

  #finish(dialog: HTMLDialogElement, confirmed: boolean, restoreFocus = true): void {
    const active = this.#active;
    if (!active || active.dialog !== dialog) return;
    this.#active = null;
    closeDialog(dialog);
    active.resolve(confirmed);
    if (restoreFocus && active.trigger?.isConnected) active.trigger.focus();
  }
}

function activeHTMLElement(document: Document): HTMLElement | null {
  const constructor = document.defaultView?.HTMLElement;
  return constructor && document.activeElement instanceof constructor
    ? document.activeElement
    : null;
}

function showModal(dialog: HTMLDialogElement): void {
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "");
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  dialog.remove();
}
