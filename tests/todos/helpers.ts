import type {
  TodoInstance,
  TodoRecurrenceRule,
  TodoTask,
  TodosPayload,
} from "../../src/todos/domain";

export function id(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

export function task(
  value: number,
  options: Partial<Omit<TodoTask, "id">> = {},
): TodoTask {
  return {
    id: id(value),
    name: `任务 ${value}`,
    weight: -1,
    completed: false,
    predecessorId: null,
    children: [],
    ...options,
  };
}

export function instance(root: TodoTask, value = 100): TodoInstance {
  const complete = root.children.length === 0
    ? root.completed
    : root.children.every((child) => child.completed);
  return {
    id: id(value),
    createdAt: "2026-08-01T00:00:00.000Z",
    reminderAt: "2026-08-01T00:00:00.000Z",
    deadlineAt: null,
    completedAt: complete ? "2026-08-01T01:00:00.000Z" : null,
    expanded: false,
    sourceRuleId: null,
    sourcePeriodKey: null,
    root,
  };
}

export function rule(template: TodoTask, value = 200): TodoRecurrenceRule {
  return {
    id: id(value),
    createdAt: "2026-08-01T00:00:00.000Z",
    cadence: "weekly",
    template,
    generatedThrough: { weekly: null, monthly: null },
  };
}

export function payload(
  instances: readonly TodoInstance[] = [],
  rules: readonly TodoRecurrenceRule[] = [],
): TodosPayload {
  return { instances, rules };
}

