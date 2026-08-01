import { effectiveWeights, findTask, isTaskComplete, taskProgress } from "./model";
import type { TodoInstance, TodoTask } from "./types";

export { effectiveWeights, findTask, isTaskComplete, taskProgress };

export function createTodoTask(id: string, name = "新子任务", weight = -1): TodoTask {
  return { id, name, weight: weight < 0 ? -1 : weight, completed: false, predecessorId: null, children: [] };
}

export function replaceTask(root: TodoTask, taskId: string, replacement: TodoTask): TodoTask {
  if (root.id === taskId) return replacement;
  let changed = false;
  const children = root.children.map((child) => {
    const next = replaceTask(child, taskId, replacement);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function toggleTodoLeaf(
  instance: TodoInstance,
  taskId: string,
  now: Date,
): TodoInstance {
  const beforeComplete = isTaskComplete(instance.root);
  const result = toggleInTree(instance.root, taskId);
  if (!result.changed) throw new TypeError("Todo leaf was not found.");
  const afterComplete = isTaskComplete(result.task);
  return {
    ...instance,
    root: result.task,
    completedAt: afterComplete
      ? beforeComplete ? instance.completedAt : now.toISOString()
      : null,
  };
}

export function insertParallelTask(
  root: TodoTask,
  selectedId: string | null,
  newTask: TodoTask,
): TodoTask {
  if (selectedId === null) {
    return { ...root, completed: false, children: [...root.children, newTask] };
  }
  return updateSiblingList(root, selectedId, (children, index) => {
    const selected = children[index]!;
    const tailId = chainTail(children, selected.id);
    const tailIndex = children.findIndex((child) => child.id === tailId);
    const next = [...children];
    next.splice(tailIndex + 1, 0, { ...newTask, predecessorId: null });
    return next;
  });
}

export function insertSuccessorTask(
  root: TodoTask,
  selectedId: string,
  newTask: TodoTask,
): TodoTask {
  return updateSiblingList(root, selectedId, (children, index) => {
    const successorIndex = children.findIndex((child) => child.predecessorId === selectedId);
    const next = children.map((child, candidateIndex) => candidateIndex === successorIndex
      ? { ...child, predecessorId: newTask.id }
      : child);
    next.splice(index + 1, 0, { ...newTask, predecessorId: selectedId });
    return next;
  });
}

export function deleteTaskAndReconnect(root: TodoTask, taskId: string): TodoTask {
  return updateSiblingList(root, taskId, (children, index) => {
    const removed = children[index]!;
    const remaining = children
      .filter((child) => child.id !== taskId)
      .map((child) => child.predecessorId === taskId
        ? { ...child, predecessorId: removed.predecessorId }
        : child);
    if (remaining.length === 0 || remaining.some((child) => child.weight < 0)) return remaining;
    const total = remaining.reduce((sum, child) => sum + child.weight, 0);
    return total > 0
      ? remaining.map((child) => ({ ...child, weight: child.weight / total }))
      : remaining.map((child) => ({ ...child, weight: 1 / remaining.length }));
  });
}

export function reorderDependencyGroup(
  root: TodoTask,
  draggedId: string,
  targetId: string,
): TodoTask {
  if (draggedId === targetId) return root;
  return updateSiblingList(root, draggedId, (children) => {
    if (!children.some((child) => child.id === targetId)) {
      throw new TypeError("依赖组只能在同一父任务下移动。");
    }
    const groups = dependencyGroups(children);
    const draggedGroup = groups.find((group) => group.some((child) => child.id === draggedId));
    const targetGroup = groups.find((group) => group.some((child) => child.id === targetId));
    if (!draggedGroup || !targetGroup || draggedGroup === targetGroup) return children;
    const reordered = groups.filter((group) => group !== draggedGroup);
    const targetIndex = reordered.indexOf(targetGroup);
    reordered.splice(targetIndex, 0, draggedGroup);
    return reordered.flat();
  });
}

export function dependencyGroups(children: readonly TodoTask[]): readonly (readonly TodoTask[])[] {
  const successors = new Map<string, TodoTask>();
  for (const child of children) {
    if (child.predecessorId) successors.set(child.predecessorId, child);
  }
  const groups: TodoTask[][] = [];
  const claimed = new Set<string>();
  for (const head of children.filter((child) => child.predecessorId === null)) {
    const group: TodoTask[] = [];
    let current: TodoTask | undefined = head;
    while (current) {
      group.push(current);
      claimed.add(current.id);
      current = successors.get(current.id);
    }
    groups.push(group);
  }
  for (const child of children) {
    if (!claimed.has(child.id)) groups.push([child]);
  }
  return groups;
}

export function setTaskWeight(root: TodoTask, taskId: string, rawWeight: number): TodoTask {
  const replacementWeight = rawWeight < 0 ? -1 : rawWeight;
  if (replacementWeight > 1 || !Number.isFinite(replacementWeight)) {
    throw new TypeError("任务占比必须为负数或 0 到 1。");
  }
  return updateSiblingList(root, taskId, (children, index) => {
    if (replacementWeight < 0) {
      return children.map((child, candidateIndex) => candidateIndex === index
        ? { ...child, weight: -1 }
        : child);
    }
    const candidate = children.map((child, candidateIndex) => candidateIndex === index
      ? { ...child, weight: replacementWeight }
      : child);
    const automaticOthers = candidate.filter((child, candidateIndex) =>
      candidateIndex !== index && child.weight < 0).length;
    const fixedTotal = candidate.reduce((sum, child) => sum + Math.max(0, child.weight), 0);
    if (automaticOthers > 0 && fixedTotal <= 1 + 1e-9) return candidate;

    const oldEffective = effectiveWeights(children);
    const remaining = Math.max(0, 1 - replacementWeight);
    const oldOtherTotal = oldEffective.reduce(
      (sum, weight, candidateIndex) => candidateIndex === index ? sum : sum + weight,
      0,
    );
    const otherCount = Math.max(1, children.length - 1);
    return candidate.map((child, candidateIndex) => {
      if (candidateIndex === index) return child;
      const weight = oldOtherTotal > 0
        ? remaining * (oldEffective[candidateIndex] ?? 0) / oldOtherTotal
        : remaining / otherCount;
      return { ...child, weight };
    });
  });
}

export function resetTaskCompletion(task: TodoTask): TodoTask {
  return {
    ...task,
    completed: false,
    children: task.children.map(resetTaskCompletion),
  };
}

export function cloneTaskWithIds(
  task: TodoTask,
  createId: () => string,
  root = true,
): TodoTask {
  const idMap = new Map<string, string>();
  const claim = (node: TodoTask): void => {
    idMap.set(node.id, createId());
    node.children.forEach(claim);
  };
  claim(task);
  const clone = (node: TodoTask, isRoot: boolean): TodoTask => ({
    id: idMap.get(node.id)!,
    name: node.name,
    weight: isRoot ? -1 : node.weight,
    completed: false,
    predecessorId: node.predecessorId ? idMap.get(node.predecessorId) ?? null : null,
    children: node.children.map((child) => clone(child, false)),
  });
  return clone(task, root);
}

function toggleInTree(task: TodoTask, taskId: string): { task: TodoTask; changed: boolean } {
  if (task.id === taskId) {
    if (task.children.length > 0) throw new TypeError("Parent task completion is derived.");
    return { task: { ...task, completed: !task.completed }, changed: true };
  }
  const directIndex = task.children.findIndex((child) => child.id === taskId);
  if (directIndex >= 0) {
    const target = task.children[directIndex]!;
    if (target.children.length > 0) throw new TypeError("Parent task completion is derived.");
    if (!target.completed && target.predecessorId) {
      const predecessor = task.children.find((child) => child.id === target.predecessorId);
      if (!predecessor || !isTaskComplete(predecessor)) {
        throw new TypeError("前置任务尚未完成。");
      }
    }
    let children = task.children.map((child, index) => index === directIndex
      ? { ...child, completed: !child.completed }
      : child);
    if (target.completed) {
      let successor = children.find((child) => child.predecessorId === target.id);
      while (successor) {
        const id = successor.id;
        children = children.map((child) => child.id === id ? resetTaskCompletion(child) : child);
        successor = children.find((child) => child.predecessorId === id);
      }
    }
    return { task: { ...task, children }, changed: true };
  }
  for (const child of task.children) {
    const nested = toggleInTree(child, taskId);
    if (nested.changed) {
      return {
        task: {
          ...task,
          children: task.children.map((candidate) => candidate.id === child.id ? nested.task : candidate),
        },
        changed: true,
      };
    }
  }
  return { task, changed: false };
}

function updateSiblingList(
  root: TodoTask,
  selectedId: string,
  update: (children: readonly TodoTask[], index: number) => readonly TodoTask[],
): TodoTask {
  const directIndex = root.children.findIndex((child) => child.id === selectedId);
  if (directIndex >= 0) {
    return { ...root, completed: false, children: update(root.children, directIndex) };
  }
  for (const child of root.children) {
    try {
      const next = updateSiblingList(child, selectedId, update);
      if (next !== child) {
        return {
          ...root,
          children: root.children.map((candidate) => candidate.id === child.id ? next : candidate),
        };
      }
    } catch (error) {
      if (!(error instanceof TaskNotFoundError)) throw error;
    }
  }
  throw new TaskNotFoundError();
}

function chainTail(children: readonly TodoTask[], startId: string): string {
  let tail = startId;
  let successor = children.find((child) => child.predecessorId === tail);
  while (successor) {
    tail = successor.id;
    successor = children.find((child) => child.predecessorId === tail);
  }
  return tail;
}

class TaskNotFoundError extends Error {}
