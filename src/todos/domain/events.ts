import {
  validateTodoInstance,
  validateTodoRule,
  validateTodosPayload,
} from "./validation";
import {
  requireArray,
  requireExactRecord,
  requireId,
  requireIndex,
} from "./validationPrimitives";
import type {
  TodoEntityChange,
  TodosEvent,
  TodosPayload,
} from "./types";

export function validateTodosEvent(value: unknown): TodosEvent {
  const record = requireExactRecord(value, "Todos event", ["type", "instances", "rules"]);
  if (record.type !== "change-entities") throw new TypeError("Invalid Todos event.");
  return {
    type: "change-entities",
    instances: validateChanges(record.instances, "Todo instance change", validateTodoInstance),
    rules: validateChanges(record.rules, "Todo rule change", validateTodoRule),
  };
}

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
  const before = validateTodosPayload(beforeValue);
  const after = validateTodosPayload(afterValue);
  if (!sameValue(applyTodosEvent(before, event), after)) {
    throw new TypeError("Todos event does not produce the supplied after payload.");
  }
  return validateTodosEvent({
    type: "change-entities",
    instances: [...event.instances].reverse().map(invertChange),
    rules: [...event.rules].reverse().map(invertChange),
  });
}

export function createTodosEvent(
  beforeValue: TodosPayload,
  afterValue: TodosPayload,
): TodosEvent {
  const before = validateTodosPayload(beforeValue);
  const after = validateTodosPayload(afterValue);
  return validateTodosEvent({
    type: "change-entities",
    instances: diffEntities(before.instances, after.instances),
    rules: diffEntities(before.rules, after.rules),
  });
}

function validateChanges<T>(
  value: unknown,
  label: string,
  validate: (value: unknown) => T,
): readonly TodoEntityChange<T>[] {
  const values = requireArray(value, `${label}s`);
  const ids = new Set<string>();
  return values.map((changeValue) => {
    const record = requireExactRecord(changeValue, label, [
      "id",
      "before",
      "after",
      "beforeIndex",
      "afterIndex",
    ]);
    const id = requireId(record.id, `${label} id`);
    if (ids.has(id)) throw new TypeError(`${label} ids cannot repeat.`);
    ids.add(id);
    const before = record.before === null ? null : validate(record.before);
    const after = record.after === null ? null : validate(record.after);
    if (before === null && after === null) {
      throw new TypeError(`${label} must change an entity.`);
    }
    if ((before !== null && entityId(before) !== id) || (after !== null && entityId(after) !== id)) {
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

function applyChanges<T extends { readonly id: string }>(
  source: readonly T[],
  changes: readonly TodoEntityChange<T>[],
  validate: (value: unknown) => T,
): readonly T[] {
  const changedIds = new Set(changes.map((change) => change.id));
  const additions = changes.filter((change) => change.after !== null).length;
  const removals = changes.filter((change) => change.before !== null).length;
  const targetLength = source.length - removals + additions;
  if (targetLength < 0) throw new TypeError("Entity event removes more entities than exist.");
  const target: Array<T | undefined> = Array.from({ length: targetLength });

  for (const change of changes) {
    const sourceIndex = source.findIndex((entity) => entity.id === change.id);
    if (change.before === null) {
      if (sourceIndex >= 0) throw new TypeError(`Entity already exists: ${change.id}`);
    } else if (
      sourceIndex !== change.beforeIndex
      || !sameValue(source[sourceIndex], change.before)
    ) {
      throw new TypeError(`Entity event before value or index is stale: ${change.id}`);
    }

    if (change.after !== null) {
      if (change.afterIndex >= targetLength) {
        throw new TypeError(`Entity event after index is out of bounds: ${change.id}`);
      }
      if (target[change.afterIndex] !== undefined) {
        throw new TypeError(`Entity events cannot share an after index: ${change.afterIndex}`);
      }
      target[change.afterIndex] = validate(change.after);
    }
  }

  const unchanged = source.filter((entity) => !changedIds.has(entity.id));
  let unchangedIndex = 0;
  for (let index = 0; index < target.length; index += 1) {
    if (target[index] === undefined) {
      target[index] = unchanged[unchangedIndex];
      unchangedIndex += 1;
    }
  }
  if (unchangedIndex !== unchanged.length || target.some((entity) => entity === undefined)) {
    throw new TypeError("Entity event indexes do not describe a complete transaction.");
  }
  return target as T[];
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
    if (sameValue(oldEntity, newEntity) && beforeIndex === afterIndex) continue;
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

function entityId(value: unknown): string {
  return (value as { readonly id: string }).id;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
