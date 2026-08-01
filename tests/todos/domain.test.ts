import { describe, expect, it } from "vitest";
import {
  applyTodosEvent,
  createTodosEvent,
  deleteTaskAndReconnect,
  effectiveWeights,
  insertSuccessorTask,
  invertTodosEvent,
  isTaskComplete,
  setTaskWeight,
  taskProgress,
  toggleTodoLeaf,
  validateTodosPayload,
} from "../../src/todos/domain";
import { id, instance, payload, task } from "./helpers";

describe("Todos domain", () => {
  it("validates an empty payload and rejects branching successors", () => {
    expect(validateTodosPayload(payload())).toEqual(payload());
    const root = task(1, {
      weight: -1,
      children: [
        task(2),
        task(3, { predecessorId: id(2) }),
        task(4, { predecessorId: id(2) }),
      ],
    });
    expect(() => validateTodosPayload(payload([instance(root)]))).toThrow(/one successor/u);
  });

  it("inserts into a single chain and reconnects it on deletion", () => {
    const root = task(1, {
      children: [task(2), task(3, { predecessorId: id(2) })],
    });
    const inserted = insertSuccessorTask(root, id(2), task(4));
    expect(inserted.children.map((child) => [child.id, child.predecessorId])).toEqual([
      [id(2), null],
      [id(4), id(2)],
      [id(3), id(4)],
    ]);
    const deleted = deleteTaskAndReconnect(inserted, id(4));
    expect(deleted.children.map((child) => [child.id, child.predecessorId])).toEqual([
      [id(2), null],
      [id(3), id(2)],
    ]);
  });

  it("locks successors and cascades uncompletion through the remaining chain", () => {
    const root = task(1, {
      children: [
        task(2),
        task(3, { predecessorId: id(2) }),
        task(4, { predecessorId: id(3) }),
      ],
    });
    let todo = instance(root);
    expect(() => toggleTodoLeaf(todo, id(3), new Date("2026-08-01T02:00:00.000Z")))
      .toThrow(/前置任务/u);
    todo = toggleTodoLeaf(todo, id(2), new Date("2026-08-01T02:00:00.000Z"));
    todo = toggleTodoLeaf(todo, id(3), new Date("2026-08-01T03:00:00.000Z"));
    todo = toggleTodoLeaf(todo, id(4), new Date("2026-08-01T04:00:00.000Z"));
    expect(isTaskComplete(todo.root)).toBe(true);
    expect(todo.completedAt).toBe("2026-08-01T04:00:00.000Z");
    todo = toggleTodoLeaf(todo, id(2), new Date("2026-08-01T05:00:00.000Z"));
    expect(todo.root.children.map((child) => child.completed)).toEqual([false, false, false]);
    expect(todo.completedAt).toBeNull();
  });

  it("calculates automatic and zero-weight progress independently from completion", () => {
    const root = task(1, {
      children: [
        task(2, { weight: 1, completed: true }),
        task(3, { weight: 0, completed: false }),
      ],
    });
    expect(taskProgress(root)).toBe(1);
    expect(isTaskComplete(root)).toBe(false);
    expect(effectiveWeights([
      task(4, { weight: 0.2 }),
      task(5),
      task(6),
    ])).toEqual([0.2, 0.4, 0.4]);
  });

  it("uses automatic freedom first and proportionally rescales on conflict", () => {
    let root = task(1, {
      children: [task(2, { weight: 0.3 }), task(3), task(4)],
    });
    root = setTaskWeight(root, id(3), 0.5);
    const automatic = effectiveWeights(root.children);
    expect(automatic[0]).toBeCloseTo(0.3);
    expect(automatic[1]).toBeCloseTo(0.5);
    expect(automatic[2]).toBeCloseTo(0.2);
    root = setTaskWeight(root, id(4), 0.4);
    const weights = root.children.map((child) => child.weight);
    expect(weights[0]).toBeCloseTo(0.225);
    expect(weights[1]).toBeCloseTo(0.375);
    expect(weights[2]).toBeCloseTo(0.4);
  });

  it("applies and inverts an entity transaction without mutating input", () => {
    const before = payload();
    const after = payload([instance(task(1))]);
    const event = createTodosEvent(before, after);
    const snapshot = structuredClone(before);
    const applied = applyTodosEvent(before, event);
    expect(applied).toEqual(after);
    expect(before).toEqual(snapshot);
    expect(applyTodosEvent(applied, invertTodosEvent(event, before, applied))).toEqual(before);
  });
});
