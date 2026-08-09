import { closeButton } from "./shell";

export interface TodoEditorDialogOptions {
  readonly mount: HTMLElement;
  readonly title: string;
  readonly trigger?: HTMLElement | null;
  readonly classNames?: string | readonly string[];
  readonly onCancel: () => void;
  readonly canCancel?: () => boolean;
}

export interface TodoEditorField {
  readonly label: HTMLLabelElement;
  readonly input: HTMLInputElement;
}

let editorDialogId = 0;

/** Stable dialog chrome shared by the instance, template and template-manager flows. */
export class TodoEditorDialog {
  readonly dialog: HTMLDialogElement;
  readonly body: HTMLElement;
  readonly actions: HTMLElement;
  readonly trigger: HTMLElement | null;

  readonly #document: Document;
  readonly #onCancel: () => void;
  readonly #canCancel: () => boolean;
  readonly #closeButton: HTMLButtonElement;
  readonly #error: HTMLElement;
  readonly #busyStatus: HTMLElement;
  readonly #disabledBeforeBusy = new Map<DisableableControl, boolean>();
  #busy = false;
  #disposed = false;

  constructor(document: Document, options: TodoEditorDialogOptions) {
    this.#document = document;
    this.#onCancel = options.onCancel;
    this.#canCancel = options.canCancel ?? (() => true);
    this.trigger = options.trigger ?? activeHTMLElement(document);

    const dialog = document.createElement("dialog");
    dialog.className = "todo-editor";
    addClassNames(dialog, options.classNames);
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.id = `todo-editor-title-${++editorDialogId}`;
    title.textContent = options.title;
    dialog.setAttribute("aria-labelledby", title.id);
    this.#closeButton = closeButton(document, "取消");
    header.append(title, this.#closeButton);

    this.#error = document.createElement("p");
    this.#error.className = "todo-editor-error";
    this.#error.hidden = true;
    this.#error.setAttribute("role", "alert");

    this.#busyStatus = document.createElement("p");
    this.#busyStatus.className = "todo-editor-busy";
    this.#busyStatus.hidden = true;
    this.#busyStatus.setAttribute("role", "status");
    this.#busyStatus.setAttribute("aria-live", "polite");

    this.body = document.createElement("div");
    this.body.className = "todo-editor-body";
    this.actions = document.createElement("footer");
    this.actions.className = "todo-editor-actions";
    dialog.append(header, this.#error, this.#busyStatus, this.body, this.actions);
    options.mount.append(dialog);
    this.dialog = dialog;

    const requestCancel = (): void => {
      if (this.canCancel) this.#onCancel();
    };
    this.#closeButton.addEventListener("click", requestCancel);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      requestCancel();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) requestCancel();
    });
  }

  get busy(): boolean {
    return this.#busy;
  }

  get canCancel(): boolean {
    return !this.#busy && this.#canCancel();
  }

  open(initialFocus?: HTMLElement): void {
    if (this.#disposed) return;
    showModal(this.dialog);
    const focus = initialFocus ?? this.#closeButton;
    this.#document.defaultView?.queueMicrotask(() => {
      if (!this.#disposed && focus.isConnected) focus.focus();
    });
  }

  setBusy(busy: boolean, stage = "正在处理…"): void {
    if (this.#disposed || busy === this.#busy) {
      if (busy && !this.#disposed) this.#busyStatus.textContent = stage;
      return;
    }
    this.#busy = busy;
    this.dialog.setAttribute("aria-busy", String(busy));
    this.#busyStatus.textContent = busy ? stage : "";
    this.#busyStatus.hidden = !busy;
    if (busy) {
      this.#disabledBeforeBusy.clear();
      for (const control of this.#controls()) {
        this.#disabledBeforeBusy.set(control, control.disabled);
        control.disabled = true;
      }
      return;
    }
    for (const [control, disabled] of this.#disabledBeforeBusy) {
      if (control.isConnected) control.disabled = disabled;
    }
    this.#disabledBeforeBusy.clear();
  }

  clearError(): void {
    if (this.#disposed) return;
    this.#error.textContent = "";
    this.#error.hidden = true;
  }

  showError(message: string, focus?: HTMLElement): void {
    if (this.#disposed) return;
    this.#error.textContent = message;
    this.#error.hidden = false;
    if (!focus) return;
    if (focus instanceof this.#document.defaultView!.HTMLInputElement) {
      focus.setAttribute("aria-invalid", "true");
      focus.addEventListener("input", () => focus.removeAttribute("aria-invalid"), { once: true });
    }
    focus.focus();
  }

  close(restoreFocus = true): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#busy = false;
    this.#disabledBeforeBusy.clear();
    closeDialog(this.dialog);
    if (restoreFocus && this.trigger?.isConnected) this.trigger.focus();
  }

  dispose(restoreFocus = true): void {
    this.close(restoreFocus);
  }

  #controls(): readonly DisableableControl[] {
    return [...this.dialog.querySelectorAll<DisableableControl>("button, input, select, textarea")];
  }
}

export function createEditorField(
  document: Document,
  labelText: string,
  type: HTMLInputElement["type"] = "text",
): TodoEditorField {
  const label = document.createElement("label");
  label.className = "todo-field";
  const text = document.createElement("span");
  text.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.autocomplete = "off";
  label.append(text, input);
  return { label, input };
}

export function createWeightEditorField(document: Document, weight: number): TodoEditorField {
  const field = createEditorField(document, "任务占比", "number");
  field.input.step = "any";
  field.input.max = "1";
  field.input.value = String(weight);
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.01";
  slider.value = String(weight < 0 ? 0 : weight);
  slider.setAttribute("aria-label", "任务占比滑杆");
  const control = document.createElement("div");
  control.className = "todo-weight-control";
  const status = document.createElement("output");
  status.className = "todo-weight-status";
  const refresh = (): void => {
    const value = Number(field.input.value);
    const automatic = Number.isFinite(value) && value < 0;
    status.textContent = automatic
      ? "自动分配"
      : Number.isFinite(value) ? `${Math.round(value * 100)}%` : "无效";
    status.dataset.automatic = String(automatic);
  };
  slider.addEventListener("input", () => {
    field.input.value = slider.value;
    refresh();
  });
  field.input.addEventListener("input", () => {
    const value = Number(field.input.value);
    if (value >= 0 && value <= 1) slider.value = String(value);
    refresh();
  });
  control.append(field.input, slider, status);
  field.label.append(control);
  refresh();
  return field;
}

export function safeEditorMessage(error: unknown, fallback: string): string {
  return error instanceof TypeError && error.message ? error.message : fallback;
}

type DisableableControl = HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function activeHTMLElement(document: Document): HTMLElement | null {
  const constructor = document.defaultView?.HTMLElement;
  return constructor && document.activeElement instanceof constructor
    ? document.activeElement
    : null;
}

function addClassNames(element: Element, classNames?: string | readonly string[]): void {
  if (!classNames) return;
  const values = typeof classNames === "string" ? [classNames] : classNames;
  for (const value of values) {
    for (const className of value.split(/\s+/u)) {
      if (className) element.classList.add(className);
    }
  }
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
