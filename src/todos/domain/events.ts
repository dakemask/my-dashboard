import {
  validateTodoInstance,
  validateTodoRule,
  validateTodosEvent,
  validateTodosPayload,
} from "./model";
import type {
  TodoEntityChange,
  TodosEvent,
  TodosPayload,
} from "./types";

export function applyTodosEvent(
  payloadValue: TodosPayload,
  eventValue: TodosEvent,
): TodosPayload {
  const payload = validateTodosPayload(payloadValue);
  const event = validateTodosEvent(eventValue);
  const instances = applyChanges(payload.instances, event.instances, validateTodoInstance);
  const rules = applyChanges(payload.rules, event.rules, validateTodoRule);
  return validateTodosPayload({ instances, rules });
}

export function invertTodosEvent(
  eventValue: TodosEvent,
  beforeValue: TodosPayload,
  afterValue: TodosPayload,
): TodosEvent {
  const event = validateTodosEvent(eventValue);
  validateTodosPayload(beforeValue);
  validateTodosPayload(afterValue);
  return validateTodosEvent({
    type: "change-entities",
    instances: [...event.instances].reverse().map(invertChange),
    rules: [...event.rules].reverse().map(invertChange),
  });
}

export function createTodosEvent(
  before: TodosPayload,
  after: TodosPayload,
): TodosEvent {
  const validBefore = validateTodosPayload(before);
  const validAfter = validateTodosPayload(after);
  return {
    type: "change-entities",
    instances: diffEntities(validBefore.instances, validAfter.instances),
    rules: diffEntities(validBefore.rules, validAfter.rules),
  };
}

function applyChanges<T extends { readonly id: string }>(
  source: readonly T[],
  changes: readonly TodoEntityChange<T>[],
  validate: (value: unknown) => T,
): readonly T[] {
  const result = [...source];
  for (const change of changes) {
    const index = result.findIndex((entity) => entity.id === change.id);
    if (change.before === null) {
      if (index >= 0) throw new TypeError(`Entity already exists: ${change.id}`);
    } else {
      if (index < 0 || JSON.stringify(result[index]) !== JSON.stringify(change.before)) {
        throw new TypeError(`Entity event before value is stale: ${change.id}`);
      }
      result.splice(index, 1);
    }
    if (change.after !== null) {
      const insertAt = Math.min(change.afterIndex, result.length);
      result.splice(insertAt, 0, validate(change.after));
    }
  }
  return result;
}

function diffEntities<T extends { readonly id: string }>(
  before: readonly T[],
  after: readonly T[],
): readonly TodoEntityChange<T>[] {
  const ids = new Set([...before.map((entity) => entity.id), ...after.map((entity) => entity.id)]);
  const changes: TodoEntityChange<T>[] = [];
  for (const id of ids) {
    const beforeIndex = before.findIndex((entity) => entity.id === id);
    const afterIndex = after.findIndex((entity) => entity.id === id);
    const oldEntity = beforeIndex < 0 ? null : before[beforeIndex]!;
    const newEntity = afterIndex < 0 ? null : after[afterIndex]!;
    if (
      JSON.stringify(oldEntity) === JSON.stringify(newEntity)
      && beforeIndex === afterIndex
    ) continue;
    changes.push({
      id,
      before: oldEntity,
      after: newEntity,
      beforeIndex,
      afterIndex,
    });
  }
  return changes;
}

function invertChange<T>(change: TodoEntityChange<T>): TodoEntityChange<T> {
  return {
    id: change.id,
    before: change.after,
    after: change.before,
    beforeIndex: change.afterIndex,
    afterIndex: change.beforeIndex,
  };
}
