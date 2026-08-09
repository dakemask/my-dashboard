// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskGraphView,
  type TaskGraphFrameScheduler,
} from "../../src/todos/ui/taskGraphView";
import type { TodoTask } from "../../src/todos/domain";
import { task } from "./helpers";

afterEach(() => {
  document.body.replaceChildren();
});

describe("TaskGraphView", () => {
  it("uses one configurable view for instance and template graphs without inline styles", () => {
    const root = task(1, { children: [task(2)] });
    const instanceFrames = new ManualFrames();
    const templateFrames = new ManualFrames();
    const instance = new TaskGraphView(document, {
      kind: "instance",
      ownerId: "instance-one",
      callbacks: { onOpenTask: vi.fn(), onToggleTask: vi.fn() },
      animationFrames: instanceFrames,
    });
    const template = new TaskGraphView(document, {
      kind: "template",
      ownerId: "template-one",
      callbacks: { onOpenTask: vi.fn() },
      animationFrames: templateFrames,
    });

    instance.render({ root, expanded: true });
    template.render({ root, expanded: true });
    instanceFrames.flush();
    templateFrames.flush();

    expect(instance.element.className).toBe("todo-graph");
    expect(instance.element.dataset.instanceId).toBe("instance-one");
    expect(instance.element.querySelectorAll(".todo-checkbox")).toHaveLength(1);
    expect(instance.element.querySelectorAll("progress.todo-progress")).toHaveLength(1);
    expect(template.element.classList.contains("todo-rule-graph")).toBe(true);
    expect(template.element.dataset.ruleId).toBe("template-one");
    expect(template.element.querySelectorAll(".todo-checkbox")).toHaveLength(0);
    expect(template.element.querySelectorAll(".todo-progress")).toHaveLength(0);
    expect(template.element.querySelector(".todo-rule-task-node")).not.toBeNull();
    expect(instance.element.querySelector("[style]")).toBeNull();
    expect(template.element.querySelector("[style]")).toBeNull();

    instance.dispose();
    template.dispose();
  });

  it("keeps keyed task, group, and connection DOM while emitting semantic callbacks", () => {
    const first = task(2);
    const successor = task(3, { predecessorId: first.id });
    const parallel = task(4);
    const initialRoot = task(1, { children: [first, successor, parallel] });
    const frames = new ManualFrames();
    const onOpenTask = vi.fn();
    const onToggleTask = vi.fn();
    const onContextTask = vi.fn();
    const onReorderGroup = vi.fn();
    const view = new TaskGraphView(document, {
      kind: "instance",
      ownerId: "instance-keyed",
      callbacks: { onOpenTask, onToggleTask, onContextTask, onReorderGroup },
      animationFrames: frames,
    });
    view.render({ root: initialRoot, expanded: true });
    frames.flush();

    const firstNode = taskNode(view, first.id);
    const firstGroup = groupElement(view, first.id);
    const parallelGroup = groupElement(view, parallel.id);
    const dependency = connectionPath(view, `dependency:${first.id}->${successor.id}`);

    firstNode.querySelector<HTMLButtonElement>(".todo-task-open")!.click();
    expect(onOpenTask).toHaveBeenCalledWith(first.id);
    const checkbox = firstNode.querySelector<HTMLInputElement>(".todo-checkbox")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggleTask).toHaveBeenCalledWith(first.id, true);
    const context = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
    });
    expect(firstNode.dispatchEvent(context)).toBe(false);
    expect(onContextTask).toHaveBeenCalledWith(first.id);

    view.requestReorder(parallel.id, first.id);
    expect(onReorderGroup).toHaveBeenCalledWith({
      parentTaskId: initialRoot.id,
      draggedGroupId: parallel.id,
      beforeGroupId: first.id,
    });
    view.requestReorder(parallel.id, successor.id);
    expect(onReorderGroup).toHaveBeenCalledTimes(1);

    const reorderedRoot = task(1, {
      children: [
        task(4, { name: "并列任务（已更新）" }),
        task(2, { completed: true }),
        task(3, { predecessorId: first.id }),
      ],
    });
    view.render({ root: reorderedRoot, expanded: true });
    frames.flush();

    expect(taskNode(view, first.id)).toBe(firstNode);
    expect(groupElement(view, first.id)).toBe(firstGroup);
    expect(groupElement(view, parallel.id)).toBe(parallelGroup);
    expect(connectionPath(view, `dependency:${first.id}->${successor.id}`)).toBe(dependency);
    expect(view.getReorderGroups().map((group) => group.groupId)).toEqual([
      parallel.id,
      first.id,
    ]);
    expect(taskNode(view, parallel.id).textContent).toContain("并列任务（已更新）");

    view.render({ root: reorderedRoot, expanded: true, disabled: true });
    expect(view.element.getAttribute("aria-disabled")).toBe("true");
    expect(taskNode(view, first.id).dataset.draggable).toBeUndefined();
    taskNode(view, first.id).querySelector<HTMLButtonElement>(".todo-task-open")!.click();
    view.requestReorder(parallel.id, first.id);
    expect(onOpenTask).toHaveBeenCalledTimes(1);
    expect(onReorderGroup).toHaveBeenCalledTimes(1);

    view.dispose();
  });

  it("evaluates nested completion gates against the complete projected root", () => {
    const predecessorLeaf = task(3);
    const predecessor = task(2, { children: [predecessorLeaf] });
    const successorLeaf = task(5);
    const successor = task(4, {
      predecessorId: predecessor.id,
      children: [successorLeaf],
    });
    const frames = new ManualFrames();
    const onToggleTask = vi.fn();
    const view = new TaskGraphView(document, {
      kind: "instance",
      ownerId: "completion-gate",
      callbacks: { onToggleTask },
      animationFrames: frames,
    });
    view.render({ root: task(1, { children: [predecessor, successor] }), expanded: true });

    const predecessorCheckbox = checkboxFor(view, predecessorLeaf.id);
    const successorCheckbox = checkboxFor(view, successorLeaf.id);
    expect(predecessorCheckbox.disabled).toBe(false);
    expect(successorCheckbox.disabled).toBe(true);
    expect(successorCheckbox.title).toBe("请先完成前置任务");
    successorCheckbox.checked = true;
    successorCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggleTask).not.toHaveBeenCalled();

    const completedPredecessor = task(2, {
      children: [task(3, { completed: true })],
    });
    const nextRoot = task(1, { children: [completedPredecessor, successor] });
    view.render({ root: nextRoot, expanded: true });
    expect(checkboxFor(view, successorLeaf.id)).toBe(successorCheckbox);
    expect(successorCheckbox.disabled).toBe(false);

    successorCheckbox.checked = true;
    successorCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggleTask).toHaveBeenCalledWith(successorLeaf.id, true);
    view.dispose();
  });

  it("restores each graph scroll position after a symmetric collapse and expand", () => {
    const frames = new ManualFrames();
    const onScrollLeftChange = vi.fn();
    const view = new TaskGraphView(document, {
      kind: "instance",
      ownerId: "scroll-owner",
      initialScrollLeft: 48,
      callbacks: { onOpenTask: vi.fn(), onScrollLeftChange },
      animationFrames: frames,
    });
    view.render({ root: task(1, { children: [task(2)] }), expanded: true });
    expect(view.element.scrollLeft).toBe(0);
    frames.flush();
    expect(view.element.scrollLeft).toBe(48);

    view.element.scrollLeft = 137;
    view.element.dispatchEvent(new Event("scroll"));
    expect(view.savedScrollLeft).toBe(137);
    expect(onScrollLeftChange).toHaveBeenLastCalledWith(137);
    view.setExpanded(false);
    expect(view.element.inert).toBe(true);
    view.element.scrollLeft = 0;
    view.setExpanded(true);
    frames.flush();
    expect(view.element.scrollLeft).toBe(137);
    expect(view.element.inert).toBe(false);
    expect(view.element.getAttribute("aria-hidden")).toBe("false");

    view.setScrollLeft(Number.NaN);
    expect(view.savedScrollLeft).toBe(0);
    expect(view.element.scrollLeft).toBe(0);
    view.dispose();
  });

  it("redraws only SVG connections affected by the supplied task ids", () => {
    const first = task(2);
    const firstSuccessor = task(3, { predecessorId: first.id });
    const second = task(4);
    const secondSuccessor = task(5, { predecessorId: second.id });
    const frames = new ManualFrames();
    const view = new TaskGraphView(document, {
      kind: "instance",
      ownerId: "partial-lines",
      callbacks: { onOpenTask: vi.fn() },
      animationFrames: frames,
    });
    view.render({
      root: task(1, { children: [first, firstSuccessor, second, secondSuccessor] }),
      expanded: true,
    });

    const canvas = view.element.querySelector<HTMLElement>(".todo-graph-canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(0, 0, 400, 200));
    let firstRect = rect(0, 0, 20, 20);
    vi.spyOn(taskNode(view, first.id), "getBoundingClientRect")
      .mockImplementation(() => firstRect);
    vi.spyOn(taskNode(view, firstSuccessor.id), "getBoundingClientRect")
      .mockReturnValue(rect(100, 0, 20, 20));
    vi.spyOn(taskNode(view, second.id), "getBoundingClientRect")
      .mockReturnValue(rect(0, 100, 20, 20));
    vi.spyOn(taskNode(view, secondSuccessor.id), "getBoundingClientRect")
      .mockReturnValue(rect(100, 100, 20, 20));
    frames.flush();

    const affected = connectionPath(view, `dependency:${first.id}->${firstSuccessor.id}`);
    const unaffected = connectionPath(view, `dependency:${second.id}->${secondSuccessor.id}`);
    const affectedBefore = affected.getAttribute("d");
    const unaffectedBefore = unaffected.getAttribute("d");
    const unaffectedSetAttribute = vi.spyOn(unaffected, "setAttribute");
    firstRect = rect(20, 0, 30, 20);

    view.redrawConnections([first.id]);
    frames.flush();

    expect(affected.getAttribute("d")).not.toBe(affectedBefore);
    expect(unaffected.getAttribute("d")).toBe(unaffectedBefore);
    expect(unaffectedSetAttribute.mock.calls.some(([name]) => name === "d")).toBe(false);
    expect(view.element.querySelector("[style]")).toBeNull();
    view.dispose();
  });

  it("redraws keyed connections when a rename changes node geometry", () => {
    const first = task(2, { name: "短名" });
    const successor = task(3, { predecessorId: first.id });
    const frames = new ManualFrames();
    const view = new TaskGraphView(document, {
      kind: "instance",
      ownerId: "rename-layout",
      callbacks: { onOpenTask: vi.fn() },
      animationFrames: frames,
    });
    view.render({ root: task(1, { children: [first, successor] }), expanded: true });

    const canvas = view.element.querySelector<HTMLElement>(".todo-graph-canvas")!;
    const firstNode = taskNode(view, first.id);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(0, 0, 400, 100));
    vi.spyOn(firstNode, "getBoundingClientRect").mockImplementation(() => {
      const name = firstNode.querySelector(".todo-task-open")?.textContent ?? "";
      return rect(0, 0, name === "短名" ? 30 : 90, 20);
    });
    vi.spyOn(taskNode(view, successor.id), "getBoundingClientRect")
      .mockReturnValue(rect(180, 0, 30, 20));
    frames.flush();
    const path = connectionPath(view, `dependency:${first.id}->${successor.id}`);
    const before = path.getAttribute("d");

    view.render({
      root: task(1, {
        children: [{ ...first, name: "显著更长的任务名称" }, successor],
      }),
      expanded: true,
    });
    frames.flush();

    expect(path.getAttribute("d")).not.toBe(before);
    view.dispose();
  });
});

function taskNode(view: TaskGraphView, taskId: string): HTMLElement {
  const node = [...view.element.querySelectorAll<HTMLElement>(".todo-task-node")]
    .find((candidate) => candidate.dataset.taskId === taskId);
  if (!node) throw new Error(`Task node ${taskId} was not rendered.`);
  return node;
}

function checkboxFor(view: TaskGraphView, taskId: string): HTMLInputElement {
  const checkbox = taskNode(view, taskId).querySelector<HTMLInputElement>(".todo-checkbox");
  if (!checkbox) throw new Error(`Task checkbox ${taskId} was not rendered.`);
  return checkbox;
}

function groupElement(view: TaskGraphView, groupId: string): HTMLElement {
  const group = view.getReorderGroups().find((candidate) => candidate.groupId === groupId)?.element;
  if (!group) throw new Error(`Task group ${groupId} was not rendered.`);
  return group;
}

function connectionPath(view: TaskGraphView, key: string): SVGPathElement {
  const path = [...view.element.querySelectorAll<SVGPathElement>("path[data-connection-key]")]
    .find((candidate) => candidate.dataset.connectionKey === key);
  if (!path) throw new Error(`Task connection ${key} was not rendered.`);
  return path;
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
  } as DOMRect;
}

class ManualFrames implements TaskGraphFrameScheduler {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextHandle = 1;

  request(callback: FrameRequestCallback): number {
    const handle = this.#nextHandle++;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }

  flush(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(0);
  }
}
