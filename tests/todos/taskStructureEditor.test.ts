// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  TaskStructureEditor,
  type TaskStructureFrameScheduler,
} from "../../src/todos/ui/taskStructureEditor";
import { task } from "./helpers";

class TestFrames implements TaskStructureFrameScheduler {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  readonly cancel = vi.fn((handle: number) => {
    this.#callbacks.delete(handle);
  });
  #next = 1;

  request(callback: FrameRequestCallback): number {
    const handle = this.#next++;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  flush(): void {
    const pending = [...this.#callbacks.entries()];
    this.#callbacks.clear();
    for (const [, callback] of pending) callback(0);
  }
}

describe("TaskStructureEditor", () => {
  it("projects only direct children with keyed rows and stable scrolling chrome", () => {
    const frames = new TestFrames();
    const editor = new TaskStructureEditor(document, {
      kind: "template",
      animationFrames: frames,
    });
    document.body.append(editor.element);
    const nested = task(4);
    const first = task(1, { name: "第一项", children: [nested] });
    const second = task(2, { name: "第二项", predecessorId: first.id });
    const parallel = task(3, { name: "并列项" });
    const root = task(9, { children: [first, parallel, second] });

    editor.render({ task: root, selectedTaskId: second.id });
    const scrollElement = editor.scrollElement;
    const firstElement = editor.getTaskRow(first.id)!.element;
    const secondElement = editor.getTaskRow(second.id)!.element;
    editor.scrollElement.scrollTop = 72;

    expect(editor.kind).toBe("template");
    expect(editor.element.querySelector("h3")?.textContent).toBe("模板子任务");
    expect(editor.getTaskRows().map((row) => row.taskId)).toEqual([
      first.id,
      second.id,
      parallel.id,
    ]);
    expect(editor.getTaskRow(nested.id)).toBeNull();
    expect(secondElement.dataset.selected).toBe("true");
    expect(editor.reorderContainer.querySelectorAll("[data-task-id]")).toHaveLength(6);

    editor.render({
      task: { ...root, children: [{ ...first, name: "改名后" }, parallel, second] },
      selectedTaskId: first.id,
    });

    expect(editor.scrollElement).toBe(scrollElement);
    expect(editor.scrollElement.scrollTop).toBe(72);
    expect(editor.getTaskRow(first.id)?.element).toBe(firstElement);
    expect(editor.getTaskRow(second.id)?.element).toBe(secondElement);
    expect(editor.getTaskRow(first.id)?.element.textContent).toContain("改名后");
    expect(editor.getTaskRow(first.id)?.element.dataset.selected).toBe("true");
    expect(editor.element.querySelector("[style]")).toBeNull();
  });

  it("exposes semantic selection and task-structure commands", () => {
    const selected = vi.fn();
    const opened = vi.fn();
    const addParallel = vi.fn();
    const addSuccessor = vi.fn();
    const remove = vi.fn();
    const editor = new TaskStructureEditor(document, {
      kind: "instance",
      animationFrames: new TestFrames(),
      callbacks: {
        onSelectTask: selected,
        onOpenTask: opened,
        onAddParallel: addParallel,
        onAddSuccessor: addSuccessor,
        onDeleteTask: remove,
      },
    });
    const child = task(1, { name: "直接子任务" });
    editor.render({ task: task(9, { children: [child] }), selectedTaskId: null });

    const row = editor.getTaskRow(child.id)!;
    const selectButton = row.dragSource as HTMLButtonElement;
    const openButton = row.element.querySelector<HTMLButtonElement>(".todo-editor-task-open")!;
    const buttons = [...editor.element.querySelectorAll<HTMLButtonElement>(".todo-editor-toolbar button")];
    const parallelButton = buttons.find((button) => button.textContent?.includes("新增并列"))!;
    const successorButton = buttons.find((button) => button.textContent?.includes("新增递进"))!;
    const deleteButton = buttons.find((button) => button.textContent?.includes("删除选中"))!;

    expect(successorButton.disabled).toBe(true);
    expect(deleteButton.disabled).toBe(true);
    parallelButton.click();
    expect(addParallel).toHaveBeenLastCalledWith(null);

    selectButton.click();
    expect(selected).toHaveBeenCalledWith(child.id);
    expect(editor.selectedTaskId).toBe(child.id);
    expect(selectButton.getAttribute("aria-pressed")).toBe("true");
    expect(successorButton.disabled).toBe(false);
    expect(deleteButton.disabled).toBe(false);

    openButton.click();
    successorButton.click();
    deleteButton.click();
    parallelButton.click();
    expect(opened).toHaveBeenCalledWith(child.id);
    expect(addSuccessor).toHaveBeenCalledWith(child.id);
    expect(remove).toHaveBeenCalledWith(child.id);
    expect(addParallel).toHaveBeenLastCalledWith(child.id);
    expect(openButton.title).toBe(openButton.getAttribute("aria-label"));

    editor.setDisabled(true);
    selectButton.click();
    openButton.click();
    expect(selected).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(parallelButton.disabled).toBe(true);
  });

  it("describes dependency groups as consecutive rows for PointerReorder", () => {
    const editor = new TaskStructureEditor(document, {
      kind: "instance",
      animationFrames: new TestFrames(),
    });
    const head = task(1);
    const tail = task(2, { predecessorId: head.id });
    const parallel = task(3);
    const root = task(9, { children: [head, parallel, tail] });
    editor.render({ task: root, selectedTaskId: null });

    const groups = editor.getReorderGroups();
    expect(groups.map((group) => ({
      parentTaskId: group.parentTaskId,
      groupId: group.groupId,
      taskIds: group.taskIds,
    }))).toEqual([
      { parentTaskId: root.id, groupId: head.id, taskIds: [head.id, tail.id] },
      { parentTaskId: root.id, groupId: parallel.id, taskIds: [parallel.id] },
    ]);
    expect(groups.flatMap((group) => group.elements)).toEqual(editor.getTaskRows().map((row) => row.element));
    for (const row of editor.getTaskRows()) {
      expect(row.element.parentElement).toBe(editor.reorderContainer);
      expect(row.element.dataset.dragGroupId).toBe(row.groupId);
      expect(row.dragSource.dataset.dragGroupId).toBe(row.groupId);
    }
  });

  it("draws keyed hooked dependency paths with separate incoming and outgoing points", () => {
    const frames = new TestFrames();
    const editor = new TaskStructureEditor(document, {
      kind: "instance",
      animationFrames: frames,
    });
    document.body.append(editor.element);
    const first = task(1);
    const middle = task(2, { predecessorId: first.id });
    const last = task(3, { predecessorId: middle.id });
    const root = task(9, { children: [first, middle, last] });
    editor.render({ task: root, selectedTaskId: null });

    setSize(editor.reorderContainer, "scrollWidth", 400);
    setSize(editor.reorderContainer, "scrollHeight", 220);
    setSize(editor.scrollElement, "clientWidth", 300);
    setSize(editor.scrollElement, "clientHeight", 180);
    mockRect(editor.reorderContainer, rect(0, 0, 400, 220));
    mockRect(editor.getTaskRow(first.id)!.element, rect(10, 10, 200, 46));
    mockRect(editor.getTaskRow(middle.id)!.element, rect(10, 64, 200, 46));
    mockRect(editor.getTaskRow(last.id)!.element, rect(10, 118, 200, 46));
    frames.flush();

    const firstPath = editor.element.querySelector<SVGPathElement>(
      `path[data-predecessor-id="${first.id}"]`,
    )!;
    const secondPath = editor.element.querySelector<SVGPathElement>(
      `path[data-predecessor-id="${middle.id}"]`,
    )!;
    expect(firstPath.getAttribute("d")).toBe("M210,41.28 C229,50.28 231,69.72 212,78.72");
    expect(secondPath.getAttribute("d")).toBe("M210,95.28 C229,104.28 231,123.72 212,132.72");
    expect(firstPath.getAttribute("marker-end")).toMatch(/^url\(#todo-editor-arrow-instance-/u);
    expect(pathEndY(firstPath)).not.toBe(pathStartY(secondPath));

    const firstPathIdentity = firstPath;
    editor.render({
      task: { ...root, children: [{ ...first, name: "第一项改名" }, middle, last] },
      selectedTaskId: null,
    });
    expect(editor.element.querySelector(`path[data-predecessor-id="${first.id}"]`)).toBe(firstPathIdentity);

    mockRect(editor.getTaskRow(first.id)!.element, rect(10, 20, 200, 46));
    frames.flush();
    const updated = firstPath.getAttribute("d");
    editor.redrawConnections([last.id]);
    mockRect(editor.getTaskRow(first.id)!.element, rect(10, 30, 200, 46));
    frames.flush();
    expect(firstPath.getAttribute("d")).toBe(updated);
    editor.redrawConnections([first.id]);
    frames.flush();
    expect(firstPath.getAttribute("d")).not.toBe(updated);
  });

  it("cancels a pending redraw and ignores later resize work after disposal", () => {
    const frames = new TestFrames();
    const selected = vi.fn();
    const opened = vi.fn();
    const addParallel = vi.fn();
    const editor = new TaskStructureEditor(document, {
      kind: "instance",
      animationFrames: frames,
      callbacks: {
        onSelectTask: selected,
        onOpenTask: opened,
        onAddParallel: addParallel,
      },
    });
    const child = task(1);
    editor.render({ task: task(9, { children: [child] }), selectedTaskId: null });
    const row = editor.getTaskRow(child.id)!;
    const select = row.dragSource as HTMLButtonElement;
    const open = row.element.querySelector<HTMLButtonElement>(".todo-editor-task-open")!;
    const parallel = [...editor.element.querySelectorAll<HTMLButtonElement>(".todo-editor-toolbar button")]
      .find((button) => button.textContent?.includes("新增并列"))!;
    editor.dispose();
    expect(frames.cancel).toHaveBeenCalledTimes(1);
    select.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    open.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    parallel.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selected).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(addParallel).not.toHaveBeenCalled();
    expect(editor.element.getAttribute("aria-disabled")).toBe("true");
    window.dispatchEvent(new Event("resize"));
    editor.redrawConnections();
    frames.flush();
    expect(editor.getTaskRows()).toEqual([]);
  });
});

function setSize(element: HTMLElement, property: "scrollWidth" | "scrollHeight" | "clientWidth" | "clientHeight", value: number): void {
  Object.defineProperty(element, property, { configurable: true, value });
}

function mockRect(element: Element, value: DOMRect): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => value,
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function pathStartY(path: SVGPathElement): number {
  return Number(path.getAttribute("d")?.match(/^M[^,]+,([^ ]+)/u)?.[1]);
}

function pathEndY(path: SVGPathElement): number {
  return Number(path.getAttribute("d")?.match(/ ([^, ]+),([^ ]+)$/u)?.[2]);
}
