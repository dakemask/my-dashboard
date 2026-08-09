// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodosPayload } from "../../src/todos/domain";
import { TodoConfirmDialog } from "../../src/todos/ui/confirmDialog";
import { TodoRecurrenceEditor } from "../../src/todos/ui/recurrenceEditor";
import { id, payload as makePayload, rule, task } from "./helpers";

afterEach(() => {
  document.body.replaceChildren();
});

describe("TodoRecurrenceEditor", () => {
  it("builds a cadence change through the template workflow and exposes settle", () => {
    const baseline = rule(task(1, { name: "每周模板" }));
    const current = makePayload([], [baseline]);
    const { editor } = createEditor(baseline, current);
    field(editor, "模板名称").value = "每月模板";
    editor.dialog.dialog.querySelector<HTMLInputElement>("input[value='monthly']")!.click();

    const next = editor.buildNext(current);
    expect(next.rules[0]!.template.name).toBe("每月模板");
    expect(next.rules[0]!.cadence).toBe("monthly");
    expect(next.instances).toHaveLength(1);
    expect(next.instances[0]!.sourceRuleId).toBe(baseline.id);
    expect(editor.settle(current)).not.toBeNull();
    expect(actionLabels(editor.dialog.dialog)).toEqual(["取消", "保存模板", "删除模板"]);
    expect(editor.dialog.dialog.querySelector("[style]")).toBeNull();
    editor.dispose();
  });

  it("carries validated root edits when opening a deeper template task", () => {
    const child = task(2, { name: "下级任务" });
    const baseline = rule(task(1, { name: "根模板", children: [child] }));
    const current = makePayload([], [baseline]);
    const openTask = vi.fn();
    const { editor } = createEditor(baseline, current, { openTask });
    field(editor, "模板名称").value = "修改后的根模板";

    editor.structureEditor.getTaskRow(child.id)!.element
      .querySelector<HTMLButtonElement>(".todo-editor-task-open")!
      .click();

    expect(openTask).toHaveBeenCalledTimes(1);
    const [draft, taskId] = openTask.mock.calls[0]!;
    expect(draft.template.name).toBe("修改后的根模板");
    expect(taskId).toBe(child.id);
    editor.dispose();
  });

  it("confirms template deletion and keeps cancellation non-destructive", async () => {
    const baseline = rule(task(1, { name: "要删除的模板" }));
    const current = makePayload([], [baseline]);
    const mount = document.createElement("main");
    document.body.append(mount);
    const confirmations = new TodoConfirmDialog(document, mount);
    const commit = vi.fn(async (_next: TodosPayload) => true);
    const requestClose = vi.fn();
    const editor = new TodoRecurrenceEditor(document, {
      mount,
      baseline,
      taskId: baseline.template.id,
      isNew: false,
      createId: idFactory(),
      getPayload: () => current,
      commit,
      confirm: (options) => confirmations.confirm(options),
      requestClose,
      openTask: vi.fn(),
      bindStructure: vi.fn(),
    });
    const remove = action(editor.dialog.dialog, "删除模板");

    remove.click();
    let confirmation = document.querySelector<HTMLDialogElement>(".todo-confirm-dialog")!;
    expect(actionLabels(confirmation)).toEqual(["取消", "删除模板"]);
    action(confirmation, "取消").click();
    await tick();
    expect(commit).not.toHaveBeenCalled();

    remove.click();
    confirmation = document.querySelector<HTMLDialogElement>(".todo-confirm-dialog")!;
    action(confirmation, "删除模板").click();
    await tick();
    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0]![0] as TodosPayload).rules).toEqual([]);
    expect(requestClose).toHaveBeenCalledTimes(1);
    editor.dispose();
    confirmations.dispose();
  });

  it("uses cancellation as the first action for a new template", () => {
    const baseline = rule(task(1, { name: "新模板" }));
    const current = makePayload();
    const requestClose = vi.fn();
    const { editor } = createEditor(baseline, current, {
      isNew: true,
      requestClose,
    });
    expect(actionLabels(editor.dialog.dialog)).toEqual(["放弃新建", "保存模板"]);
    action(editor.dialog.dialog, "放弃新建").click();
    expect(requestClose).toHaveBeenCalledTimes(1);
    editor.dispose();
  });
});

function createEditor(
  baseline: ReturnType<typeof rule>,
  current: TodosPayload,
  overrides: Partial<ConstructorParameters<typeof TodoRecurrenceEditor>[1]> = {},
): { editor: TodoRecurrenceEditor; mount: HTMLElement } {
  const mount = document.createElement("main");
  document.body.append(mount);
  const editor = new TodoRecurrenceEditor(document, {
    mount,
    baseline,
    taskId: baseline.template.id,
    isNew: false,
    createId: idFactory(),
    getPayload: () => current,
    commit: async () => true,
    confirm: async () => true,
    requestClose: vi.fn(),
    openTask: vi.fn(),
    bindStructure: vi.fn(),
    now: () => new Date("2026-08-09T04:00:00.000Z"),
    ...overrides,
  });
  return { editor, mount };
}

function field(editor: TodoRecurrenceEditor, label: string): HTMLInputElement {
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

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
