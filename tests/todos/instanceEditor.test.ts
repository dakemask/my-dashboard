// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoConfirmDialog } from "../../src/todos/ui/confirmDialog";
import { TodoInstanceEditor } from "../../src/todos/ui/instanceEditor";
import type { TodosPayload } from "../../src/todos/domain";
import { id, instance, payload as makePayload, rule, task } from "./helpers";

afterEach(() => {
  document.body.replaceChildren();
});

describe("TodoInstanceEditor", () => {
  it("builds and settles one instance draft with date and source-template wiring", async () => {
    const child = task(2, { name: "直接子任务" });
    const baseline = {
      ...instance(task(1, { name: "原待办", children: [child] })),
      sourceRuleId: id(200),
      sourcePeriodKey: "2026-W32",
    };
    const sourceRule = rule(task(50, { name: "来源模板" }));
    let current = makePayload([baseline], [sourceRule]);
    const { editor } = createEditor(baseline, current, {
      getPayload: () => current,
    });
    const name = field(editor, "任务名称");
    name.value = "修改后的待办";

    editor.dialog.dialog.querySelector<HTMLButtonElement>("[data-date-role='deadline']")!.click();
    const dateDialog = document.querySelector<HTMLDialogElement>(".todo-date-dialog")!;
    const specific = dateDialog.querySelector<HTMLInputElement>("input[aria-label='具体日期']")!;
    specific.value = "202608201230";
    specific.dispatchEvent(new Event("input", { bubbles: true }));
    action(dateDialog, "确认").click();
    await tick();

    const next = editor.buildNext(current, "overwrite-template");
    const saved = next.instances[0]!;
    expect(saved.root.name).toBe("修改后的待办");
    expect(saved.deadlineAt).not.toBeNull();
    expect(next.rules[0]!.template.name).toBe("修改后的待办");
    expect(next.rules[0]!.template.id).not.toBe(saved.root.id);
    expect(editor.settle(current)).not.toBeNull();
    expect(actionLabels(editor.dialog.dialog)).toEqual([
      "取消",
      "保存并覆盖周期模板",
      "保存",
      "删除任务",
    ]);
    expect(editor.dialog.dialog.querySelector("[style]")).toBeNull();

    current = next;
    editor.dispose();
  });

  it("blocks cancellation while saving and recovers after a failed commit", async () => {
    const baseline = instance(task(1, { name: "待保存" }));
    const current = makePayload([baseline]);
    const pending = deferred<boolean>();
    const commit = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(true);
    const requestClose = vi.fn();
    const { editor } = createEditor(baseline, current, { commit, requestClose });
    editor.open();
    const save = action(editor.dialog.dialog, "保存");
    save.click();

    expect(editor.dialog.dialog.getAttribute("aria-busy")).toBe("true");
    expect(editor.dialog.dialog.querySelector<HTMLElement>(".todo-editor-busy")?.textContent)
      .toBe("正在保存…");
    editor.dialog.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    editor.dialog.dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(requestClose).not.toHaveBeenCalled();

    pending.resolve(false);
    await tick();
    expect(editor.dialog.dialog.getAttribute("aria-busy")).toBe("false");
    expect(save.disabled).toBe(false);
    expect(editor.dialog.dialog.querySelector<HTMLElement>(".todo-editor-error")?.hidden)
      .toBe(false);

    save.click();
    await tick();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(requestClose).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  it("uses the page confirmation flow before deleting and leaves cancel non-destructive", async () => {
    const baseline = instance(task(1, { name: "要删除" }));
    const current = makePayload([baseline]);
    const mount = document.createElement("main");
    document.body.append(mount);
    const confirmations = new TodoConfirmDialog(document, mount);
    const commit = vi.fn(async (_next: TodosPayload) => true);
    const requestClose = vi.fn();
    const editor = new TodoInstanceEditor(document, {
      mount,
      baseline,
      taskId: baseline.root.id,
      isNew: false,
      createId: idFactory(),
      getPayload: () => current,
      commit,
      confirm: (options) => confirmations.confirm(options),
      requestClose,
      openTask: vi.fn(),
      bindStructure: vi.fn(),
    });
    const remove = action(editor.dialog.dialog, "删除任务");

    remove.click();
    let confirmation = document.querySelector<HTMLDialogElement>(".todo-confirm-dialog")!;
    expect(actionLabels(confirmation)).toEqual(["取消", "删除任务"]);
    action(confirmation, "取消").click();
    await tick();
    expect(commit).not.toHaveBeenCalled();
    expect(editor.dialog.dialog.isConnected).toBe(true);

    remove.click();
    confirmation = document.querySelector<HTMLDialogElement>(".todo-confirm-dialog")!;
    action(confirmation, "删除任务").click();
    await tick();
    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0]![0] as TodosPayload).instances).toEqual([]);
    expect(requestClose).toHaveBeenCalledTimes(1);
    editor.dispose();
    confirmations.dispose();
  });
});

function createEditor(
  baseline: ReturnType<typeof instance>,
  current: TodosPayload,
  overrides: Partial<ConstructorParameters<typeof TodoInstanceEditor>[1]> = {},
): { editor: TodoInstanceEditor; mount: HTMLElement } {
  const mount = document.createElement("main");
  document.body.append(mount);
  const editor = new TodoInstanceEditor(document, {
    mount,
    baseline,
    taskId: baseline.root.id,
    isNew: false,
    createId: idFactory(),
    getPayload: () => current,
    commit: async () => true,
    confirm: async () => true,
    requestClose: vi.fn(),
    openTask: vi.fn(),
    bindStructure: vi.fn(),
    ...overrides,
  });
  return { editor, mount };
}

function field(editor: TodoInstanceEditor, label: string): HTMLInputElement {
  return [...editor.dialog.dialog.querySelectorAll<HTMLLabelElement>(".todo-field")]
    .find((candidate) => candidate.querySelector("span")?.textContent === label)!
    .querySelector("input")!;
}

function action(dialog: HTMLDialogElement, label: string): HTMLButtonElement {
  return [...dialog.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === label)!;
}

function actionLabels(dialog: HTMLDialogElement): string[] {
  const scope = dialog.classList.contains("todo-confirm-dialog")
    ? ".todo-confirm-actions button"
    : ".todo-editor-actions button";
  return [...dialog.querySelectorAll<HTMLButtonElement>(scope)]
    .map((button) => button.textContent ?? "");
}

function idFactory(): () => string {
  let value = 500;
  return () => id(value++);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
