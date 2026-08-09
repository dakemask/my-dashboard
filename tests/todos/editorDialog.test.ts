// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoEditorDialog } from "../../src/todos/ui/editorDialog";

afterEach(() => {
  document.body.replaceChildren();
});

describe("TodoEditorDialog", () => {
  it("provides an accessible stable shell and restores its trigger", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开编辑器";
    const mount = document.createElement("main");
    document.body.append(trigger, mount);
    trigger.focus();
    const cancelled = vi.fn();
    const editor = new TodoEditorDialog(document, {
      mount,
      title: "编辑任务",
      onCancel: cancelled,
    });
    const input = document.createElement("input");
    editor.body.append(input);
    editor.open(input);
    await tick();

    expect(document.activeElement).toBe(input);
    expect(editor.dialog.getAttribute("aria-labelledby")).toBe(
      editor.dialog.querySelector("h2")?.id,
    );
    expect(editor.dialog.querySelector("h2")?.textContent).toBe("编辑任务");
    expect(editor.dialog.querySelector("[style]")).toBeNull();

    editor.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(cancelled).toHaveBeenCalledTimes(1);
    editor.dispose();
    expect(document.activeElement).toBe(trigger);
  });

  it("announces busy stages, blocks every close path, and restores controls", () => {
    const mount = document.createElement("main");
    document.body.append(mount);
    const cancelled = vi.fn();
    const editor = new TodoEditorDialog(document, {
      mount,
      title: "新建模板",
      onCancel: cancelled,
    });
    const input = document.createElement("input");
    const initiallyDisabled = document.createElement("button");
    initiallyDisabled.disabled = true;
    const save = document.createElement("button");
    editor.body.append(input, initiallyDisabled);
    editor.actions.append(save);

    editor.setBusy(true, "正在保存模板…");
    expect(editor.busy).toBe(true);
    expect(editor.dialog.getAttribute("aria-busy")).toBe("true");
    expect(editor.dialog.querySelector<HTMLElement>(".todo-editor-busy")?.textContent)
      .toBe("正在保存模板…");
    expect(editor.dialog.querySelector<HTMLElement>(".todo-editor-busy")?.hidden).toBe(false);
    expect([...editor.dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")]
      .every((control) => control.disabled)).toBe(true);

    editor.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    editor.dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    editor.dialog.querySelector<HTMLButtonElement>("header button")!.click();
    expect(cancelled).not.toHaveBeenCalled();

    editor.setBusy(false);
    expect(editor.dialog.getAttribute("aria-busy")).toBe("false");
    expect(input.disabled).toBe(false);
    expect(save.disabled).toBe(false);
    expect(initiallyDisabled.disabled).toBe(true);
    editor.dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
