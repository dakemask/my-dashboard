import type { TodoInstance, TodoTask } from "./types";

export interface TodoTaskLocation {
  readonly task: TodoTask;
  readonly parent: TodoTask | null;
  readonly siblings: readonly TodoTask[];
  readonly index: number;
  readonly ancestors: readonly TodoTask[];
}

export type TodoTaskCompletionGate =
  | {
    readonly allowed: true;
    readonly task: TodoTask;
  }
  | {
    readonly allowed: false;
    readonly reason: "not-found" | "derived" | "predecessor-incomplete";
    readonly task: TodoTask | null;
    readonly predecessor: TodoTask | null;
  };

export function createTodoTask(id: string, name = "新子任务", weight = -1): TodoTask {
  return { id, name, weight: weight < 0 ? -1 : weight, completed: false, predecessorId: null, children: [] };
}

export function visitTask(task: TodoTask, visitor: (task: TodoTask) => void): void {
  visitor(task);
  for (const child of task.children) visitTask(child, visitor);
}

export function findTask(task: TodoTask, id: string): TodoTask | null {
  if (task.id === id) return task;
  for (const child of task.children) {
    const match = findTask(child, id);
    if (match) return match;
  }
  return null;
}

export function findTaskLocation(root: TodoTask, id: string): TodoTaskLocation | null {
  const path = findTaskPath(root, id);
  if (!path) return null;
  const current = path[path.length - 1]!;
  return {
    task: current.task,
    parent: path.length > 1 ? path[path.length - 2]!.task : null,
    siblings: current.siblings,
    index: current.siblings.findIndex((task) => task.id === current.task.id),
    ancestors: path.slice(0, -1).map((entry) => entry.task),
  };
}

export function isTaskComplete(task: TodoTask): boolean {
  return task.children.length === 0
    ? task.completed
    : task.children.every(isTaskComplete);
}

export function taskCompletionGate(root: TodoTask, taskId: string): TodoTaskCompletionGate {
  const path = findTaskPath(root, taskId);
  if (!path) {
    return { allowed: false, reason: "not-found", task: null, predecessor: null };
  }
  const target = path[path.length - 1]!.task;
  if (target.children.length > 0) {
    return { allowed: false, reason: "derived", task: target, predecessor: null };
  }
  if (target.completed) return { allowed: true, task: target };

  for (const entry of path) {
    if (entry.task.predecessorId === null) continue;
    const predecessor = entry.siblings.find((task) => task.id === entry.task.predecessorId) ?? null;
    if (!predecessor || !isTaskComplete(predecessor)) {
      return {
        allowed: false,
        reason: "predecessor-incomplete",
        task: target,
        predecessor,
      };
    }
  }
  return { allowed: true, task: target };
}

export function canToggleTodoTask(root: TodoTask, taskId: string): boolean {
  return taskCompletionGate(root, taskId).allowed;
}

export function effectiveWeights(children: readonly TodoTask[]): readonly number[] {
  if (children.length === 0) return [];
  const automatic = children.filter((child) => child.weight < 0).length;
  const fixed = children.reduce((sum, child) => sum + Math.max(0, child.weight), 0);
  const automaticWeight = automatic > 0 ? Math.max(0, 1 - fixed) / automatic : 0;
  return children.map((child) => child.weight < 0 ? automaticWeight : child.weight);
}

export function taskProgress(task: TodoTask): number {
  if (task.children.length === 0) return task.completed ? 1 : 0;
  const weights = effectiveWeights(task.children);
  return Math.min(1, Math.max(0, task.children.reduce(
    (sum, child, index) => sum + taskProgress(child) * (weights[index] ?? 0),
    0,
  )));
}

export function replaceTask(root: TodoTask, taskId: string, replacement: TodoTask): TodoTask {
  if (root.id === taskId) return replacement;
  let changed = false;
  let children = root.children.map((child) => {
    const next = replaceTask(child, taskId, replacement);
    if (next !== child) changed = true;
    return next;
  });
  if (changed) children = resetInvalidatedSuccessors(root.children, children);
  return changed ? { ...root, children } : root;
}

export function replaceTodoInstanceRoot(
  instance: TodoInstance,
  root: TodoTask,
  now: Date,
): TodoInstance {
  const beforeComplete = isTaskComplete(instance.root);
  const afterComplete = isTaskComplete(root);
  return {
    ...instance,
    root,
    completedAt: afterComplete
      ? beforeComplete ? instance.completedAt : now.toISOString()
      : null,
  };
}

export function toggleTodoLeaf(
  instance: TodoInstance,
  taskId: string,
  now: Date,
): TodoInstance {
  const gate = taskCompletionGate(instance.root, taskId);
  if (!gate.allowed) {
    if (gate.reason === "not-found") throw new TypeError("Todo leaf was not found.");
    if (gate.reason === "derived") throw new TypeError("Parent task completion is derived.");
    throw new TypeError("前置任务尚未完成。");
  }
  const result = toggleInTree(instance.root, taskId);
  return replaceTodoInstanceRoot(instance, result.task, now);
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
  beforeGroupId: string | null,
): TodoTask {
  if (draggedId === beforeGroupId) return root;
  return updateSiblingList(root, draggedId, (children) => {
    const groups = dependencyGroups(children);
    const draggedGroup = groups.find((group) => group.some((child) => child.id === draggedId));
    const targetGroup = beforeGroupId === null
      ? null
      : groups.find((group) => group[0]?.id === beforeGroupId);
    if (!draggedGroup) return children;
    if (beforeGroupId !== null && !targetGroup) {
      throw new TypeError("依赖组只能在同一父任务下移动。");
    }
    if (draggedGroup === targetGroup) return children;
    const reordered = groups.filter((group) => group !== draggedGroup);
    const targetIndex = targetGroup ? reordered.indexOf(targetGroup) : reordered.length;
    reordered.splice(Math.max(0, targetIndex), 0, draggedGroup);
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
    return { task: { ...task, completed: !task.completed }, changed: true };
  }
  for (const child of task.children) {
    const nested = toggleInTree(child, taskId);
    if (nested.changed) {
      let children = task.children.map((candidate) => candidate.id === child.id ? nested.task : candidate);
      if (isTaskComplete(child) && !isTaskComplete(nested.task)) {
        children = resetSuccessorChain(children, child.id);
      }
      return {
        task: {
          ...task,
          children,
        },
        changed: true,
      };
    }
  }
  return { task, changed: false };
}

interface TodoTaskPathEntry {
  readonly task: TodoTask;
  readonly siblings: readonly TodoTask[];
}

function findTaskPath(root: TodoTask, taskId: string): readonly TodoTaskPathEntry[] | null {
  const visit = (
    task: TodoTask,
    siblings: readonly TodoTask[],
    ancestors: readonly TodoTaskPathEntry[],
  ): readonly TodoTaskPathEntry[] | null => {
    const path = [...ancestors, { task, siblings }];
    if (task.id === taskId) return path;
    for (const child of task.children) {
      const match = visit(child, task.children, path);
      if (match) return match;
    }
    return null;
  };
  return visit(root, [root], []);
}

function resetSuccessorChain(
  childrenValue: readonly TodoTask[],
  predecessorId: string,
): TodoTask[] {
  let children = [...childrenValue];
  let successor = children.find((child) => child.predecessorId === predecessorId);
  while (successor) {
    const id = successor.id;
    children = children.map((child) => child.id === id ? resetTaskCompletion(child) : child);
    successor = children.find((child) => child.predecessorId === id);
  }
  return children;
}

function updateSiblingList(
  root: TodoTask,
  selectedId: string,
  update: (children: readonly TodoTask[], index: number) => readonly TodoTask[],
): TodoTask {
  const directIndex = root.children.findIndex((child) => child.id === selectedId);
  if (directIndex >= 0) {
    const children = resetInvalidatedSuccessors(
      root.children,
      update(root.children, directIndex),
    );
    return { ...root, completed: false, children };
  }
  for (const child of root.children) {
    try {
      const next = updateSiblingList(child, selectedId, update);
      if (next !== child) {
        const children = resetInvalidatedSuccessors(
          root.children,
          root.children.map((candidate) => candidate.id === child.id ? next : candidate),
        );
        return {
          ...root,
          children,
        };
      }
    } catch (error) {
      if (!(error instanceof TaskNotFoundError)) throw error;
    }
  }
  throw new TaskNotFoundError();
}

function resetInvalidatedSuccessors(
  before: readonly TodoTask[],
  afterValue: readonly TodoTask[],
): TodoTask[] {
  let after = [...afterValue];
  for (const previous of before) {
    const current = after.find((task) => task.id === previous.id);
    if (current && isTaskComplete(previous) && !isTaskComplete(current)) {
      after = resetSuccessorChain(after, previous.id);
    }
  }
  for (const task of after) {
    if (task.predecessorId === null || !hasStoredCompletion(task)) continue;
    const predecessor = after.find((candidate) => candidate.id === task.predecessorId);
    if (predecessor && !isTaskComplete(predecessor)) {
      after = resetSuccessorChain(after, predecessor.id);
    }
  }
  return after;
}

function hasStoredCompletion(task: TodoTask): boolean {
  return task.completed || task.children.some(hasStoredCompletion);
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
