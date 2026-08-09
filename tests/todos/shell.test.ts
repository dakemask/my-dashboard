// @vitest-environment jsdom

import { CloseSmall } from "@icon-park/svg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { iconButton, TodosShell } from "../../src/todos/ui/shell";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("TodosShell feedback", () => {
  it("keeps ordinary feedback for 4200ms and errors for 6200ms", () => {
    vi.useFakeTimers();
    const shell = createShell();

    shell.showMessage("已完成", "success");
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

  it("keeps local-save failure visible until explicitly cleared", () => {
    const shell = createShell();
    shell.setSaveFailure(true);
    expect(shell.elements.saveFailure.hidden).toBe(false);
    expect(shell.elements.saveFailure.getAttribute("role")).toBe("alert");
    shell.setSaveFailure(false);
    expect(shell.elements.saveFailure.hidden).toBe(true);
  });
});

describe("Todos IconPark controls", () => {
  it("uses the Shared icon-only button semantics", () => {
    const button = iconButton(document, CloseSmall, "关闭编辑器");

    expect(button.type).toBe("button");
    expect(button.title).toBe("关闭编辑器");
    expect(button.getAttribute("aria-label")).toBe(button.title);
    expect(button.querySelector("svg")?.getAttribute("width")).toBe("20");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

function createShell(): TodosShell {
  const root = document.createElement("div");
  document.body.append(root);
  return new TodosShell(root);
}
