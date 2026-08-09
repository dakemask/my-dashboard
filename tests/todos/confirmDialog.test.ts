// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { TodoConfirmDialog } from "../../src/todos/ui/confirmDialog";

afterEach(() => {
  document.body.replaceChildren();
});

describe("TodoConfirmDialog", () => {
  it("orders cancellation before destructive confirmation and initially focuses cancel", async () => {
    const { confirmations, mount, trigger } = createConfirmations();
    trigger.focus();
    const result = confirmations.confirm({
      title: "删除任务？",
      message: "当前任务及其全部子任务都会被删除。",
      confirmLabel: "删除任务",
    });
    const dialog = confirmDialog();
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>(".todo-confirm-actions button")];

    expect(buttons.map((button) => button.textContent)).toEqual(["取消", "删除任务"]);
    expect(buttons[1]!.classList.contains("danger")).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")?.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(dialog.querySelector("p")?.id);
    expect(mount.querySelector("[style]")).toBeNull();

    buttons[1]!.click();
    expect(await result).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores Escape, backdrop, and cancel while cancellation is unsafe", async () => {
    let safe = false;
    const { confirmations, trigger } = createConfirmations();
    trigger.focus();
    const result = confirmations.confirm({
      title: "删除模板？",
      message: "模板会停止生成新待办。",
      confirmLabel: "删除模板",
      canCancel: () => safe,
    });
    const dialog = confirmDialog();
    const cancel = dialog.querySelector<HTMLButtonElement>(".todo-confirm-actions button")!;

    const cancelEvent = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    cancel.click();
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.isConnected).toBe(true);

    safe = true;
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(await result).toBe(false);
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("restores the explicit trigger when cancelling from the backdrop", async () => {
    const { confirmations, trigger } = createConfirmations();
    const unrelated = document.createElement("button");
    unrelated.textContent = "别的按钮";
    document.body.append(unrelated);
    unrelated.focus();
    const result = confirmations.confirm({
      title: "确认操作？",
      message: "可以安全取消。",
      confirmLabel: "继续",
      destructive: false,
      trigger,
    });
    const dialog = confirmDialog();

    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await result).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

function createConfirmations(): {
  confirmations: TodoConfirmDialog;
  mount: HTMLElement;
  trigger: HTMLButtonElement;
} {
  const mount = document.createElement("main");
  const trigger = document.createElement("button");
  trigger.textContent = "打开确认";
  document.body.append(trigger, mount);
  return {
    confirmations: new TodoConfirmDialog(document, mount),
    mount,
    trigger,
  };
}

function confirmDialog(): HTMLDialogElement {
  return document.querySelector<HTMLDialogElement>(".todo-confirm-dialog")!;
}
