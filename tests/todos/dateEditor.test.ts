// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseTodoSpecificDate,
  reminderFromDeadline,
} from "../../src/todos/domain";
import {
  formatTodoDisplayDate,
  sanitizeTodoSpecificDateInput,
  TodoDateEditor,
  type TodoDateValue,
} from "../../src/todos/ui/dateEditor";

afterEach(() => {
  document.body.replaceChildren();
});

describe("TodoDateEditor", () => {
  it("keeps input cleanup and display formatting beside the date UI", () => {
    expect(sanitizeTodoSpecificDateInput("20a26-08/15 12:30")).toBe("202608151230");
    expect(sanitizeTodoSpecificDateInput("-1x2")).toBe("-12");
    expect(sanitizeTodoSpecificDateInput("--12")).toBe("-12");
    expect(formatTodoDisplayDate(null)).toBe("无限远");
    expect(formatTodoDisplayDate("2026-08-15T04:30:00.000Z")).not.toBe("");
  });

  it("supports specific and relative choices through one stable editor", async () => {
    const changed = vi.fn();
    const initial: TodoDateValue = {
      reminderAt: "2026-08-10T04:30:00.000Z",
      deadlineAt: "2026-08-20T04:30:00.000Z",
    };
    const { editor } = createEditor(initial, { onChange: changed });
    const deadlineTrigger = summary("deadline");
    deadlineTrigger.focus();
    deadlineTrigger.click();

    let dialog = dateDialog();
    expect(actionLabels(dialog)).toEqual(["取消", "确认"]);
    const specific = field(dialog, "具体日期");
    specific.value = "2026/08/15 12:30";
    specific.dispatchEvent(new Event("input", { bubbles: true }));
    expect(specific.value).toBe("202608151230");
    clickAction(dialog, "确认");
    await tick();

    const expectedDeadline = parseTodoSpecificDate("202608151230", "deadline")!;
    expect(changed).toHaveBeenLastCalledWith({
      reminderAt: initial.reminderAt,
      deadlineAt: expectedDeadline,
    });
    expect(editor.value.deadlineAt).toBe(expectedDeadline);
    expect(document.activeElement).toBe(deadlineTrigger);

    const reminderTrigger = summary("reminder");
    reminderTrigger.focus();
    reminderTrigger.click();
    dialog = dateDialog();
    const relative = field(dialog, "距离截止日期的天数");
    relative.focus();
    relative.value = "2";
    relative.dispatchEvent(new Event("input", { bubbles: true }));
    clickAction(dialog, "确认");
    await tick();

    expect(changed).toHaveBeenLastCalledWith({
      reminderAt: reminderFromDeadline(expectedDeadline, 2),
      deadlineAt: expectedDeadline,
    });
    expect(document.activeElement).toBe(reminderTrigger);
    expect(document.querySelector(".todo-date-dialog")).toBeNull();
    expect(editor.element.querySelector("[style]")).toBeNull();
  });

  it("keeps field errors in place and lets the user retry", async () => {
    const now = new Date("2026-08-12T01:02:03.000Z");
    const { editor } = createEditor({
      reminderAt: "2026-08-10T04:30:00.000Z",
      deadlineAt: null,
    }, { now: () => now });
    const trigger = summary("reminder");
    const choice = editor.chooseDate("reminder", trigger);
    const dialog = dateDialog();
    const relative = field(dialog, "距离截止日期的天数");
    relative.focus();
    relative.value = "1";
    relative.dispatchEvent(new Event("input", { bubbles: true }));
    clickAction(dialog, "确认");

    const error = dialog.querySelector<HTMLElement>("[role='alert']")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("截止日期为无限远时不能反推提醒日期。");
    expect(relative.getAttribute("aria-invalid")).toBe("true");
    expect(dialog.isConnected).toBe(true);

    const specific = field(dialog, "具体日期");
    specific.focus();
    specific.value = "-9";
    specific.dispatchEvent(new Event("input", { bubbles: true }));
    expect(error.hidden).toBe(false);
    clickAction(dialog, "确认");

    expect(await choice).toEqual({ reminderAt: now.toISOString(), deadlineAt: null });
    expect(dialog.isConnected).toBe(false);
  });

  it("only lets Escape or the backdrop close when cancellation is safe", async () => {
    let safe = false;
    const { editor } = createEditor({
      reminderAt: "2026-08-10T04:30:00.000Z",
      deadlineAt: null,
    }, { canCancel: () => safe });
    const trigger = summary("deadline");
    trigger.focus();
    const choice = editor.chooseDate("deadline", trigger);
    const dialog = dateDialog();

    const cancelEvent = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(dialog.isConnected).toBe(true);
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.isConnected).toBe(true);

    safe = true;
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await choice).toBeNull();
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

function createEditor(
  value: TodoDateValue,
  options: Partial<Pick<ConstructorParameters<typeof TodoDateEditor>[1], "onChange" | "now" | "canCancel">> = {},
): { editor: TodoDateEditor; mount: HTMLElement } {
  const mount = document.createElement("main");
  document.body.append(mount);
  const editor = new TodoDateEditor(document, { mount, value, ...options });
  mount.append(editor.element);
  return { editor, mount };
}

function dateDialog(): HTMLDialogElement {
  return document.querySelector<HTMLDialogElement>(".todo-date-dialog")!;
}

function summary(role: "reminder" | "deadline"): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`[data-date-role="${role}"]`)!;
}

function field(dialog: HTMLDialogElement, label: string): HTMLInputElement {
  return dialog.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

function actionLabels(dialog: HTMLDialogElement): string[] {
  return [...dialog.querySelectorAll<HTMLButtonElement>(".todo-date-dialog-actions button")]
    .map((button) => button.textContent ?? "");
}

function clickAction(dialog: HTMLDialogElement, label: string): void {
  [...dialog.querySelectorAll<HTMLButtonElement>(".todo-date-dialog-actions button")]
    .find((button) => button.textContent === label)!
    .click();
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
