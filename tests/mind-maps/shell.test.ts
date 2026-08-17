// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MindMapShell } from "../../src/mind-maps/ui/shell";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement): void { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement): void { this.removeAttribute("open"); },
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("MindMapShell controls", () => {
  it("uses accessible Shared IconPark buttons with the documented dense exception", () => {
    const shell = createShell();
    const iconButtons = [
      shell.elements.homeButton,
      shell.elements.sidebarButton,
      shell.elements.addNodeButton,
      shell.elements.addArrowButton,
      shell.elements.resetViewButton,
      shell.elements.newFolderButton,
      shell.elements.newMapButton,
      shell.elements.renameButton,
      shell.elements.deleteButton,
    ];
    for (const button of iconButtons) {
      expect(button.type).toBe("button");
      expect(button.title).toBe(button.getAttribute("aria-label"));
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(shell.elements.homeButton.querySelector("svg")?.getAttribute("width")).toBe("20");
    expect(shell.elements.newFolderButton.querySelector("svg")?.getAttribute("width")).toBe("16");
  });
});

describe("MindMapShell feedback", () => {
  it("uses status/4200ms for ordinary feedback and alert/6200ms for errors", () => {
    vi.useFakeTimers();
    const shell = createShell();

    shell.showMessage("已保存");
    expect(shell.elements.toast.getAttribute("role")).toBe("status");
    vi.advanceTimersByTime(4_199);
    expect(shell.elements.toast.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shell.elements.toast.hidden).toBe(true);

    shell.showMessage("保存失败", "error");
    expect(shell.elements.toast.getAttribute("role")).toBe("alert");
    expect(shell.elements.toast.getAttribute("aria-live")).toBe("assertive");
    vi.advanceTimersByTime(6_199);
    expect(shell.elements.toast.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shell.elements.toast.hidden).toBe(true);
  });

  it("orders cancel first and danger last, focuses cancel, then restores the trigger", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开";
    const root = document.createElement("div");
    document.body.append(trigger, root);
    const shell = new MindMapShell(root);
    trigger.focus();

    const result = shell.choose("确认", "选择操作", [
      { id: "delete", label: "删除", tone: "danger" },
      { id: "continue", label: "继续", tone: "primary" },
      { id: "cancel", label: "取消" },
    ]);
    expect(shell.dialogOpen).toBe(true);
    const buttons = [...root.querySelectorAll<HTMLButtonElement>(".dialog-button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["取消", "继续", "删除"]);
    expect(document.activeElement).toBe(buttons[0]);

    buttons[2]!.click();
    await expect(result).resolves.toBe("delete");
    expect(shell.dialogOpen).toBe(false);
    await Promise.resolve();
    expect(document.activeElement).toBe(trigger);
  });

  it("allows Escape and backdrop cancellation only when an explicit cancel choice exists", async () => {
    const shell = createShell();
    const escaped = shell.choose("安全取消", "内容", [
      { id: "confirm", label: "确认", tone: "primary" },
      { id: "cancel", label: "取消" },
    ]);
    const dialog = document.querySelector<HTMLDialogElement>(".mind-maps-dialog")!;
    const cancelEvent = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    await expect(escaped).resolves.toBe("cancel");

    let resolved = false;
    const required = shell.choose("必须选择", "内容", [
      { id: "confirm", label: "确认", tone: "primary" },
    ]).then((choice) => { resolved = true; return choice; });
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    dialog.click();
    await Promise.resolve();
    expect(resolved).toBe(false);
    document.querySelector<HTMLButtonElement>(".dialog-button")!.click();
    await expect(required).resolves.toBe("confirm");
  });
});

function createShell(): MindMapShell {
  const root = document.createElement("div");
  document.body.append(root);
  return new MindMapShell(root);
}
