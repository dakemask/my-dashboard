import { cloneTaskWithIds } from "./tasks";
import type {
  TodoCadence,
  TodoInstance,
  TodoRecurrenceRule,
  TodosPayload,
} from "./types";

export interface TodoPeriod {
  readonly cadence: TodoCadence;
  readonly start: Date;
  readonly end: Date;
  readonly key: string;
}

export interface TodoGenerationResult {
  readonly instances: readonly TodoInstance[];
  readonly rules: readonly TodoRecurrenceRule[];
}

export function todoPeriod(cadence: TodoCadence, value = new Date()): TodoPeriod {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);
  if (cadence === "weekly") {
    const day = start.getDay();
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  } else {
    start.setDate(1);
  }
  const end = nextPeriodStart(cadence, start);
  return {
    cadence,
    start,
    end,
    key: `${cadence}:${start.toISOString()}`,
  };
}

export function createPeriodicInstance(
  rule: TodoRecurrenceRule,
  period: TodoPeriod,
  createId: () => string,
  createdAt = new Date(),
): TodoInstance {
  return {
    id: createId(),
    createdAt: createdAt.toISOString(),
    reminderAt: period.start.toISOString(),
    deadlineAt: period.end.toISOString(),
    completedAt: null,
    expanded: false,
    sourceRuleId: rule.id,
    sourcePeriodKey: period.key,
    root: cloneTaskWithIds(rule.template, createId),
  };
}

export function initializeRulePeriod(
  rule: TodoRecurrenceRule,
  now: Date,
  createId: () => string,
): { rule: TodoRecurrenceRule; instance: TodoInstance | null } {
  const period = todoPeriod(rule.cadence, now);
  const cursor = rule.generatedThrough[rule.cadence];
  if (cursor !== null && Date.parse(cursor) >= period.start.getTime()) {
    return { rule, instance: null };
  }
  const nextRule = withCursor(rule, rule.cadence, period.start.toISOString());
  return {
    rule: nextRule,
    instance: createPeriodicInstance(nextRule, period, createId, now),
  };
}

export function generateMissingPeriodicInstances(
  payload: TodosPayload,
  now: Date,
  createId: () => string,
): TodoGenerationResult {
  const instances: TodoInstance[] = [];
  const rules = payload.rules.map((rule) => {
    const current = todoPeriod(rule.cadence, now);
    const cursorValue = rule.generatedThrough[rule.cadence];
    if (cursorValue === null) {
      instances.push(createPeriodicInstance(rule, current, createId, now));
      return withCursor(rule, rule.cadence, current.start.toISOString());
    }
    let cursor = new Date(cursorValue);
    let nextRule = rule;
    while (true) {
      const next = nextPeriodStart(rule.cadence, cursor);
      if (next.getTime() > current.start.getTime()) break;
      const period = todoPeriod(rule.cadence, next);
      instances.push(createPeriodicInstance(nextRule, period, createId, now));
      nextRule = withCursor(nextRule, rule.cadence, period.start.toISOString());
      cursor = next;
    }
    return nextRule;
  });
  return { instances, rules };
}

export function nextTodoBoundary(rules: readonly TodoRecurrenceRule[], now: Date): Date | null {
  if (rules.length === 0) return null;
  return rules.reduce<Date | null>((nearest, rule) => {
    const boundary = todoPeriod(rule.cadence, now).end;
    return !nearest || boundary < nearest ? boundary : nearest;
  }, null);
}

function withCursor(
  rule: TodoRecurrenceRule,
  cadence: TodoCadence,
  cursor: string,
): TodoRecurrenceRule {
  return {
    ...rule,
    generatedThrough: { ...rule.generatedThrough, [cadence]: cursor },
  };
}

function nextPeriodStart(cadence: TodoCadence, start: Date): Date {
  const next = new Date(start);
  if (cadence === "weekly") next.setDate(next.getDate() + 7);
  else next.setMonth(next.getMonth() + 1, 1);
  return next;
}

