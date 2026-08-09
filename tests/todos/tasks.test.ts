import { describe, expect, it } from "vitest";
import {
  canToggleTodoTask,
  deleteTaskAndReconnect,
  dependencyGroups,
  effectiveWeights,
  findTask,
  findTaskLocation,
  insertParallelTask,
  insertSuccessorTask,
  isTaskComplete,
  reorderDependencyGroup,
  replaceTask,
  replaceTodoInstanceRoot,
  setTaskWeight,
  taskCompletionGate,
  taskProgress,
  toggleTodoLeaf,
  visitTask,
} from "../../src/todos/domain/tasks";
import { id, instance, task } from "./helpers";

describe("Todos task rules", () => {
  it("queries a recursive task tree with parent and sibling context", () => {
    const root = task(1, {
      children: [
        task(2, { children: [task(3), task(4)] }),
        task(5),
      ],
    });
    const visited: string[] = [];
    visitTask(root, (item) => visited.push(item.id));
    expect(visited).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(findTask(root, id(4))?.name).toBe("任务 4");
    const location = findTaskLocation(root, id(4));
    expect(location?.parent?.id).toBe(id(2));
    expect(location?.siblings.map((item) => item.id)).toEqual([id(3), id(4)]);
    expect(location?.index).toBe(1);
    expect(location?.ancestors.map((item) => item.id)).toEqual([id(1), id(2)]);
    expect(findTaskLocation(root, id(99))).toBeNull();
  });

  it("gates an entire successor subtree behind its predecessor subtree", () => {
    const blocked = task(1, {
      children: [
        task(2, { children: [task(3)] }),
        task(4, { predecessorId: id(2), children: [task(5)] }),
      ],
    });
    expect(taskCompletionGate(blocked, id(5))).toMatchObject({
      allowed: false,
      reason: "predecessor-incomplete",
      predecessor: { id: id(2) },
    });
    expect(canToggleTodoTask(blocked, id(5))).toBe(false);
    expect(() => toggleTodoLeaf(instance(blocked), id(5), new Date())).toThrow(/前置任务/u);

    const ready = replaceTask(blocked, id(3), { ...task(3), completed: true });
    expect(canToggleTodoTask(ready, id(5))).toBe(true);
    expect(toggleTodoLeaf(instance(ready), id(5), new Date("2026-08-02T00:00:00.000Z"))
      .root.children[1]?.children[0]?.completed).toBe(true);
  });

  it("cascades deep uncompletion through successor groups at every ancestor", () => {
    const completeRoot = task(1, {
      children: [
        task(2, { children: [task(3, { completed: true })] }),
        task(4, {
          predecessorId: id(2),
          children: [task(5, { completed: true })],
        }),
        task(6, {
          predecessorId: id(4),
          children: [task(7, { completed: true })],
        }),
      ],
    });
    expect(isTaskComplete(completeRoot)).toBe(true);
    const source = {
      ...instance(completeRoot),
      completedAt: "2026-08-01T01:00:00.000Z",
    };
    const result = toggleTodoLeaf(source, id(3), new Date("2026-08-02T00:00:00.000Z"));
    expect(result.completedAt).toBeNull();
    expect(result.root.children.map((item) => isTaskComplete(item))).toEqual([false, false, false]);
    expect(result.root.children[1]?.children[0]?.completed).toBe(false);
    expect(result.root.children[2]?.children[0]?.completed).toBe(false);
  });

  it("cascades successor completion when editing makes a predecessor subtree incomplete", () => {
    const predecessor = task(2, {
      children: [task(3, { completed: true })],
    });
    const successor = task(4, {
      predecessorId: predecessor.id,
      children: [task(5, { completed: true })],
    });
    const root = task(1, { children: [predecessor, successor] });

    const replaced = replaceTask(
      root,
      task(3).id,
      task(3, { completed: false }),
    );
    expect(replaced.children.map(isTaskComplete)).toEqual([false, false]);
    expect(replaced.children[1]?.children[0]?.completed).toBe(false);

    const structurallyEdited = insertParallelTask(
      root,
      task(3).id,
      task(6),
    );
    expect(structurallyEdited.children.map(isTaskComplete)).toEqual([false, false]);
    expect(structurallyEdited.children[1]?.children[0]?.completed).toBe(false);

    const insertedSuccessor = insertSuccessorTask(root, predecessor.id, task(7));
    expect(insertedSuccessor.children.map(isTaskComplete)).toEqual([true, false, false]);
    expect(insertedSuccessor.children[2]?.children[0]?.completed).toBe(false);
  });

  it("derives instance completion time whenever a root structure is replaced", () => {
    const source = instance(task(1));
    const completed = replaceTodoInstanceRoot(
      source,
      { ...source.root, completed: true },
      new Date("2026-08-02T03:04:05.000Z"),
    );
    expect(completed.completedAt).toBe("2026-08-02T03:04:05.000Z");
    expect(replaceTodoInstanceRoot(
      completed,
      { ...completed.root, completed: false },
      new Date("2026-08-03T00:00:00.000Z"),
    ).completedAt).toBeNull();
  });

  it("keeps structure CRUD and dependency-group reorder immutable", () => {
    const source = task(1, {
      children: [
        task(2),
        task(3, { predecessorId: id(2) }),
        task(4),
      ],
    });
    const snapshot = structuredClone(source);
    const inserted = insertSuccessorTask(source, id(2), task(5));
    expect(inserted.children.map((item) => [item.id, item.predecessorId])).toEqual([
      [id(2), null],
      [id(5), id(2)],
      [id(3), id(5)],
      [id(4), null],
    ]);
    const parallel = insertParallelTask(inserted, id(2), task(6));
    expect(dependencyGroups(parallel.children).map((group) => group.map((item) => item.id))).toEqual([
      [id(2), id(5), id(3)],
      [id(6)],
      [id(4)],
    ]);
    const reordered = reorderDependencyGroup(parallel, id(3), id(4));
    expect(dependencyGroups(reordered.children).map((group) => group[0]?.id)).toEqual([
      id(6), id(2), id(4),
    ]);
    const deleted = deleteTaskAndReconnect(inserted, id(5));
    expect(deleted.children[1]?.predecessorId).toBe(id(2));
    expect(source).toEqual(snapshot);
  });

  it("allocates effective weights and derives recursive progress", () => {
    let root = task(1, {
      children: [
        task(2, { weight: 0.2, completed: true }),
        task(3),
        task(4),
      ],
    });
    expect(effectiveWeights(root.children)).toEqual([0.2, 0.4, 0.4]);
    expect(taskProgress(root)).toBeCloseTo(0.2);
    root = setTaskWeight(root, id(3), 0.5);
    const allocated = effectiveWeights(root.children);
    expect(allocated[0]).toBeCloseTo(0.2);
    expect(allocated[1]).toBeCloseTo(0.5);
    expect(allocated[2]).toBeCloseTo(0.3);
    root = setTaskWeight(root, id(4), 0.5);
    expect(root.children[0]?.weight).toBeCloseTo(1 / 7);
    expect(root.children[1]?.weight).toBeCloseTo(5 / 14);
    expect(root.children[2]?.weight).toBeCloseTo(0.5);
  });
});
