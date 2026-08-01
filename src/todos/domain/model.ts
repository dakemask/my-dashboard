import type {
  TodoEntityChange,
  TodoInstance,
  TodoRecurrenceRule,
  TodoTask,
  TodosEvent,
  TodosPayload,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EPSILON = 1e-9;

export function createEmptyTodosPayload(): TodosPayload {
  return { instances: [], rules: [] };
}

export function validateTodosPayload(value: unknown): TodosPayload {
  const record = requireRecord(value, "Todos payload", ["instances", "rules"]);
  const instances = requireArray(record.instances, "Todo instances").map(validateTodoInstance);
  const rules = requireArray(record.rules, "Todo recurrence rules").map(validateTodoRule);
  const ids = new Set<string>();
  for (const instance of instances) {
    claimId(ids, instance.id);
    visitTask(instance.root, (task) => claimId(ids, task.id));
  }
  for (const rule of rules) {
    claimId(ids, rule.id);
    visitTask(rule.template, (task) => claimId(ids, task.id));
  }
  return { instances, rules };
}

export function validateTodoInstance(value: unknown): TodoInstance {
  const record = requireRecord(value, "Todo instance", [
    "id", "createdAt", "reminderAt", "deadlineAt", "completedAt", "expanded",
    "sourceRuleId", "sourcePeriodKey", "root",
  ]);
  const root = validateTodoTask(record.root, true, false);
  const complete = isTaskComplete(root);
  const completedAt = optionalIso(record.completedAt, "Todo completion time");
  if (complete !== (completedAt !== null)) {
    throw new TypeError("Todo completion time must match the derived task completion state.");
  }
  const sourceRuleId = optionalId(record.sourceRuleId, "Todo source rule id");
  const sourcePeriodKey = optionalString(record.sourcePeriodKey, "Todo source period key");
  if ((sourceRuleId === null) !== (sourcePeriodKey === null)) {
    throw new TypeError("Todo source rule and period must either both exist or both be null.");
  }
  return {
    id: requireId(record.id, "Todo id"),
    createdAt: requireIso(record.createdAt, "Todo creation time"),
    reminderAt: requireIso(record.reminderAt, "Todo reminder time"),
    deadlineAt: optionalIso(record.deadlineAt, "Todo deadline time"),
    completedAt,
    expanded: requireBoolean(record.expanded, "Todo expanded state"),
    sourceRuleId,
    sourcePeriodKey,
    root,
  };
}

export function validateTodoRule(value: unknown): TodoRecurrenceRule {
  const record = requireRecord(value, "Todo recurrence rule", [
    "id", "createdAt", "cadence", "template", "generatedThrough",
  ]);
  const cadence = record.cadence;
  if (cadence !== "weekly" && cadence !== "monthly") {
    throw new TypeError("Todo recurrence cadence must be weekly or monthly.");
  }
  const cursor = requireRecord(record.generatedThrough, "Todo generation cursor", [
    "weekly", "monthly",
  ]);
  return {
    id: requireId(record.id, "Todo recurrence rule id"),
    createdAt: requireIso(record.createdAt, "Todo recurrence rule creation time"),
    cadence,
    template: validateTodoTask(record.template, true, true),
    generatedThrough: {
      weekly: optionalIso(cursor.weekly, "Weekly generation cursor"),
      monthly: optionalIso(cursor.monthly, "Monthly generation cursor"),
    },
  };
}

export function validateTodoTask(
  value: unknown,
  root = false,
  template = false,
): TodoTask {
  const record = requireRecord(value, "Todo task", [
    "id", "name", "weight", "completed", "predecessorId", "children",
  ]);
  const name = requireString(record.name, "Todo task name").trim();
  if (!name) throw new TypeError("Todo task name cannot be empty.");
  const weightValue = requireNumber(record.weight, "Todo task weight");
  const weight = weightValue < 0 ? -1 : weightValue;
  if ((!root && weight > 1) || (root && weight !== -1)) {
    throw new TypeError("Todo task weight must be automatic or between zero and one.");
  }
  const predecessorId = optionalId(record.predecessorId, "Todo predecessor id");
  if (root && predecessorId !== null) throw new TypeError("Root tasks cannot have predecessors.");
  const children = requireArray(record.children, "Todo task children")
    .map((child) => validateTodoTask(child, false, template));
  validateSiblingChains(children);
  validateWeights(children);
  const completed = requireBoolean(record.completed, "Todo task completion state");
  if ((children.length > 0 || template) && completed) {
    throw new TypeError("Templates and non-leaf tasks cannot store direct completion.");
  }
  return {
    id: requireId(record.id, "Todo task id"),
    name,
    weight,
    completed,
    predecessorId,
    children,
  };
}

export function validateTodosEvent(value: TodosEvent): TodosEvent {
  if (!value || value.type !== "change-entities") throw new TypeError("Invalid Todos event.");
  return {
    type: "change-entities",
    instances: validateChanges(value.instances, "Todo instance change", validateTodoInstance),
    rules: validateChanges(value.rules, "Todo rule change", validateTodoRule),
  };
}

function validateChanges<T>(
  values: readonly TodoEntityChange<T>[],
  label: string,
  validate: (value: unknown) => T,
): readonly TodoEntityChange<T>[] {
  if (!Array.isArray(values)) throw new TypeError(`${label}s must be an array.`);
  const ids = new Set<string>();
  return values.map((change) => {
    const record = requireRecord(change, label, ["id", "before", "after", "beforeIndex", "afterIndex"]);
    const id = requireId(record.id, `${label} id`);
    if (ids.has(id)) throw new TypeError(`${label} ids cannot repeat.`);
    ids.add(id);
    const before = record.before === null ? null : validate(record.before);
    const after = record.after === null ? null : validate(record.after);
    if (!before && !after) throw new TypeError(`${label} must change an entity.`);
    if ((before && entityId(before) !== id) || (after && entityId(after) !== id)) {
      throw new TypeError(`${label} entity id is inconsistent.`);
    }
    return {
      id,
      before,
      after,
      beforeIndex: requireIndex(record.beforeIndex, `${label} before index`, before !== null),
      afterIndex: requireIndex(record.afterIndex, `${label} after index`, after !== null),
    };
  });
}

function entityId(value: unknown): string {
  return (value as { id: string }).id;
}

export function isTaskComplete(task: TodoTask): boolean {
  return task.children.length === 0
    ? task.completed
    : task.children.every(isTaskComplete);
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

function validateWeights(children: readonly TodoTask[]): void {
  if (children.length === 0) return;
  const automatic = children.filter((child) => child.weight < 0).length;
  const fixed = children.reduce((sum, child) => sum + Math.max(0, child.weight), 0);
  if (fixed > 1 + EPSILON) throw new TypeError("Fixed child task weights cannot exceed one.");
  if (automatic === 0 && Math.abs(fixed - 1) > EPSILON) {
    throw new TypeError("Fully specified child task weights must add up to one.");
  }
}

function validateSiblingChains(children: readonly TodoTask[]): void {
  const ids = new Set(children.map((child) => child.id));
  const successors = new Map<string, string>();
  for (const child of children) {
    const predecessor = child.predecessorId;
    if (predecessor === null) continue;
    if (!ids.has(predecessor) || predecessor === child.id) {
      throw new TypeError("Todo predecessor must reference a different sibling.");
    }
    if (successors.has(predecessor)) {
      throw new TypeError("A Todo task can have at most one successor.");
    }
    successors.set(predecessor, child.id);
  }
  for (const child of children) {
    const seen = new Set<string>();
    let current: string | null = child.id;
    while (current) {
      if (seen.has(current)) throw new TypeError("Todo dependency chains cannot contain cycles.");
      seen.add(current);
      current = children.find((candidate) => candidate.id === current)?.predecessorId ?? null;
    }
  }
}

function claimId(ids: Set<string>, id: string): void {
  if (ids.has(id)) throw new TypeError(`Duplicate Todo id: ${id}`);
  ids.add(id);
}

function requireRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has missing or extra fields.`);
  }
  return record;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  return value === null ? null : requireString(value, label);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  const id = requireString(value, label).toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new TypeError(`${label} must be a UUID.`);
  return id;
}

function optionalId(value: unknown, label: string): string | null {
  return value === null ? null : requireId(value, label);
}

function requireIso(value: unknown, label: string): string {
  const text = requireString(value, label);
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return text;
}

function optionalIso(value: unknown, label: string): string | null {
  return value === null ? null : requireIso(value, label);
}

function requireIndex(value: unknown, label: string, present: boolean): number {
  if (!Number.isInteger(value) || (present ? (value as number) < 0 : value !== -1)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value as number;
}

