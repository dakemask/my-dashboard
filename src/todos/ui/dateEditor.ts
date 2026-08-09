import { ArrowRight } from "@icon-park/svg";
import {
  deadlineFromReminder,
  formatTodoDateInput,
  parseTodoSpecificDate,
  reconcileTodoDates,
  reminderFromDeadline,
  type TodoDateRole,
} from "../domain";
import { createTodoIcon } from "./icons";
import { textButton } from "./shell";

export interface TodoDateValue {
  readonly reminderAt: string;
  readonly deadlineAt: string | null;
}

export interface TodoDateEditorOptions {
  readonly mount: HTMLElement;
  readonly value: TodoDateValue;
  readonly onChange?: (value: TodoDateValue) => void;
  readonly now?: () => Date;
  readonly canCancel?: () => boolean;
}

interface DateSummary {
  readonly button: HTMLButtonElement;
  readonly value: HTMLElement;
}

interface ActiveDateDialog {
  readonly dialog: HTMLDialogElement;
  readonly trigger: HTMLElement;
  readonly promise: Promise<TodoDateValue | null>;
  readonly resolve: (value: TodoDateValue | null) => void;
  readonly cancelButton: HTMLButtonElement;
  readonly confirmButton: HTMLButtonElement;
  readonly specificInput: HTMLInputElement;
  readonly relativeInput: HTMLInputElement;
}

let dateDialogId = 0;

export class TodoDateEditor {
  readonly element: HTMLElement;

  readonly #document: Document;
  readonly #mount: HTMLElement;
  readonly #onChange: (value: TodoDateValue) => void;
  readonly #now: () => Date;
  readonly #canCancel: () => boolean;
  readonly #reminderSummary: DateSummary;
  readonly #deadlineSummary: DateSummary;
  #value: TodoDateValue;
  #activeDialog: ActiveDateDialog | null = null;
  #disabled = false;
  #disposed = false;

  constructor(document: Document, options: TodoDateEditorOptions) {
    this.#document = document;
    this.#mount = options.mount;
    this.#onChange = options.onChange ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#canCancel = options.canCancel ?? (() => true);
    this.#value = copyDateValue(options.value);

    const section = document.createElement("section");
    section.className = "todo-date-editor";
    this.#reminderSummary = createDateSummary(document, "reminder", "提醒日期");
    this.#deadlineSummary = createDateSummary(document, "deadline", "截止日期");
    section.append(this.#reminderSummary.button, this.#deadlineSummary.button);
    this.element = section;

    this.#reminderSummary.button.addEventListener("click", () => {
      void this.#editFromSummary("reminder", this.#reminderSummary.button);
    });
    this.#deadlineSummary.button.addEventListener("click", () => {
      void this.#editFromSummary("deadline", this.#deadlineSummary.button);
    });
    this.#refresh();
  }

  get value(): TodoDateValue {
    return copyDateValue(this.#value);
  }

  setValue(value: TodoDateValue): void {
    if (this.#disposed) return;
    this.#value = copyDateValue(value);
    this.#refresh();
  }

  setDisabled(disabled: boolean): void {
    if (this.#disposed) return;
    this.#disabled = disabled;
    this.#reminderSummary.button.disabled = disabled;
    this.#deadlineSummary.button.disabled = disabled;
    const active = this.#activeDialog;
    if (!active) return;
    active.dialog.setAttribute("aria-busy", String(disabled));
    active.cancelButton.disabled = disabled;
    active.confirmButton.disabled = disabled;
    active.specificInput.disabled = disabled;
    active.relativeInput.disabled = disabled;
  }

  chooseDate(role: TodoDateRole, trigger?: HTMLElement): Promise<TodoDateValue | null> {
    if (this.#disposed || this.#disabled) return Promise.resolve(null);
    if (this.#activeDialog) return this.#activeDialog.promise;

    const baseValue = this.value;
    const actualTrigger = trigger ?? (
      role === "reminder" ? this.#reminderSummary.button : this.#deadlineSummary.button
    );
    const dialog = this.#document.createElement("dialog");
    dialog.className = "todo-date-dialog";
    const panel = this.#document.createElement("div");
    panel.className = "todo-dialog-panel";
    const title = this.#document.createElement("h2");
    const id = ++dateDialogId;
    title.id = `todo-date-dialog-title-${id}`;
    title.textContent = role === "reminder" ? "设置提醒日期" : "设置截止日期";
    dialog.setAttribute("aria-labelledby", title.id);

    const specificField = this.#document.createElement("label");
    specificField.className = "todo-date-field";
    const specificHeading = this.#document.createElement("span");
    specificHeading.textContent = "具体日期";
    const specific = this.#document.createElement("input");
    specific.type = "text";
    specific.inputMode = "numeric";
    specific.maxLength = 13;
    specific.autocomplete = "off";
    specific.value = formatTodoDateInput(role === "reminder" ? baseValue.reminderAt : baseValue.deadlineAt);
    specific.placeholder = "YYYYMMDDHHmm 或负数";
    specific.setAttribute("aria-label", "具体日期");
    specific.setAttribute("aria-invalid", "false");
    specificField.append(specificHeading, specific);

    const separator = this.#document.createElement("span");
    separator.className = "todo-date-or";
    separator.textContent = "或";

    const relativeField = this.#document.createElement("label");
    relativeField.className = "todo-date-field";
    const relativeHeading = this.#document.createElement("span");
    relativeHeading.textContent = role === "reminder" ? "距离截止日期的天数" : "距离提醒日期的天数";
    const relative = this.#document.createElement("input");
    relative.type = "number";
    relative.min = "0";
    relative.step = "1";
    relative.placeholder = "非负整数";
    relative.setAttribute("aria-label", relativeHeading.textContent);
    relative.setAttribute("aria-invalid", "false");
    relativeField.append(relativeHeading, relative);

    const error = this.#document.createElement("p");
    error.id = `todo-date-dialog-error-${id}`;
    error.className = "todo-editor-error";
    error.hidden = true;
    error.setAttribute("role", "alert");
    specific.setAttribute("aria-errormessage", error.id);
    relative.setAttribute("aria-errormessage", error.id);

    const actions = this.#document.createElement("div");
    actions.className = "todo-date-dialog-actions";
    const cancel = textButton(this.#document, "取消", "todos-button subtle");
    const confirm = textButton(this.#document, "确认", "todos-button primary");
    actions.append(cancel, confirm);
    panel.append(title, specificField, separator, relativeField, error, actions);
    dialog.append(panel);
    this.#mount.append(dialog);

    let resolveChoice!: (value: TodoDateValue | null) => void;
    const promise = new Promise<TodoDateValue | null>((resolve) => {
      resolveChoice = resolve;
    });
    const active: ActiveDateDialog = {
      dialog,
      trigger: actualTrigger,
      promise,
      resolve: resolveChoice,
      cancelButton: cancel,
      confirmButton: confirm,
      specificInput: specific,
      relativeInput: relative,
    };
    this.#activeDialog = active;

    let mode: "specific" | "relative" = "specific";
    const chooseSpecific = (): void => { mode = "specific"; };
    const chooseRelative = (): void => { mode = "relative"; };
    specific.addEventListener("focus", chooseSpecific);
    specific.addEventListener("input", () => {
      chooseSpecific();
      specific.value = sanitizeTodoSpecificDateInput(specific.value);
    });
    relative.addEventListener("focus", chooseRelative);
    relative.addEventListener("input", chooseRelative);

    const cancelChoice = (): void => {
      if (this.#isSafeToCancel()) this.#finishDateChoice(active, null);
    };
    cancel.addEventListener("click", cancelChoice);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelChoice();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) cancelChoice();
    });
    confirm.addEventListener("click", () => {
      specific.setAttribute("aria-invalid", "false");
      relative.setAttribute("aria-invalid", "false");
      try {
        const value = mode === "specific"
          ? dateValueFromSpecific(role, baseValue, specific.value, this.#now())
          : dateValueFromRelative(role, baseValue, relative.value);
        this.#finishDateChoice(active, value);
      } catch (caught) {
        error.textContent = safeDateMessage(caught);
        error.hidden = false;
        (mode === "specific" ? specific : relative).setAttribute("aria-invalid", "true");
      }
    });

    showModal(dialog);
    specific.focus();
    specific.select();
    return promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const active = this.#activeDialog;
    if (active) this.#finishDateChoice(active, null, false);
    this.element.remove();
  }

  async #editFromSummary(role: TodoDateRole, trigger: HTMLElement): Promise<void> {
    const value = await this.chooseDate(role, trigger);
    if (!value || this.#disposed) return;
    this.setValue(value);
    this.#onChange(this.value);
  }

  #finishDateChoice(
    active: ActiveDateDialog,
    value: TodoDateValue | null,
    restoreFocus = true,
  ): void {
    if (this.#activeDialog !== active) return;
    this.#activeDialog = null;
    closeDialog(active.dialog);
    active.resolve(value === null ? null : copyDateValue(value));
    if (restoreFocus && active.trigger.isConnected) active.trigger.focus();
  }

  #isSafeToCancel(): boolean {
    return !this.#disabled && this.#canCancel();
  }

  #refresh(): void {
    this.#reminderSummary.value.textContent = formatTodoDisplayDate(this.#value.reminderAt);
    this.#deadlineSummary.value.textContent = formatTodoDisplayDate(this.#value.deadlineAt);
  }
}

export function sanitizeTodoSpecificDateInput(value: string): string {
  if (value.startsWith("-")) return `-${value.slice(1).replace(/\D/gu, "")}`;
  return value.replace(/\D/gu, "");
}

export function formatTodoDisplayDate(value: string | null): string {
  if (value === null) return "无限远";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function createDateSummary(
  document: Document,
  role: TodoDateRole,
  label: string,
): DateSummary {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "todo-date-summary";
  button.dataset.dateRole = role;
  button.setAttribute("aria-haspopup", "dialog");
  const heading = document.createElement("strong");
  heading.textContent = label;
  const value = document.createElement("span");
  button.append(heading, value, createTodoIcon(document, ArrowRight, 17));
  return { button, value };
}

function dateValueFromSpecific(
  role: TodoDateRole,
  current: TodoDateValue,
  rawValue: string,
  now: Date,
): TodoDateValue {
  const parsed = parseTodoSpecificDate(rawValue, role, now);
  if (role === "reminder") {
    if (parsed === null) throw new TypeError("提醒日期不能设为无限远。");
    return reconcileTodoDates(parsed, current.deadlineAt, role);
  }
  return reconcileTodoDates(current.reminderAt, parsed, role);
}

function dateValueFromRelative(
  role: TodoDateRole,
  current: TodoDateValue,
  rawValue: string,
): TodoDateValue {
  if (rawValue.trim() === "") throw new TypeError("请输入相对天数。");
  const days = Number(rawValue);
  if (role === "reminder") {
    if (current.deadlineAt === null) {
      throw new TypeError("截止日期为无限远时不能反推提醒日期。");
    }
    return {
      reminderAt: reminderFromDeadline(current.deadlineAt, days),
      deadlineAt: current.deadlineAt,
    };
  }
  return {
    reminderAt: current.reminderAt,
    deadlineAt: deadlineFromReminder(current.reminderAt, days),
  };
}

function copyDateValue(value: TodoDateValue): TodoDateValue {
  return { reminderAt: value.reminderAt, deadlineAt: value.deadlineAt };
}

function safeDateMessage(error: unknown): string {
  return error instanceof TypeError ? error.message : "日期设置无效。";
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
