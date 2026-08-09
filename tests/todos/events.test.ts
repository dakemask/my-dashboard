import { describe, expect, it } from "vitest";
import {
  applyTodosEvent,
  createTodosEvent,
  invertTodosEvent,
  validateTodosEvent,
} from "../../src/todos/domain/events";
import type { TodosEvent } from "../../src/todos/domain/types";
import { instance, payload, rule, task } from "./helpers";

describe("Todos events", () => {
  it("diffs, applies and inverts a mixed entity transaction", () => {
    const first = instance(task(1), 101);
    const second = instance(task(2), 102);
    const sourceRule = rule(task(3), 201);
    const before = payload([first, second], [sourceRule]);
    const after = payload([
      second,
      { ...first, expanded: true },
      instance(task(4), 103),
    ], [{ ...sourceRule, cadence: "monthly" }]);
    const beforeSnapshot = structuredClone(before);
    const afterSnapshot = structuredClone(after);

    const event = createTodosEvent(before, after);
    const eventSnapshot = structuredClone(event);
    const applied = applyTodosEvent(before, event);
    expect(applied).toEqual(after);
    expect(applyTodosEvent(applied, invertTodosEvent(event, before, applied))).toEqual(before);
    expect(before).toEqual(beforeSnapshot);
    expect(after).toEqual(afterSnapshot);
    expect(event).toEqual(eventSnapshot);
  });

  it("creates an empty transaction for identical payloads", () => {
    const value = payload([instance(task(1), 101)]);
    expect(createTodosEvent(value, structuredClone(value))).toEqual({
      type: "change-entities",
      instances: [],
      rules: [],
    });
  });

  it("strictly validates event shape and change identity", () => {
    expect(() => validateTodosEvent({
      type: "change-entities",
      instances: [],
      rules: [],
      extra: true,
    })).toThrow(/extra fields/u);

    const before = payload();
    const after = payload([instance(task(1), 101)]);
    const event = createTodosEvent(before, after);
    expect(() => validateTodosEvent({
      ...event,
      instances: [event.instances[0], event.instances[0]],
    })).toThrow(/cannot repeat/u);
    expect(() => validateTodosEvent({
      ...event,
      instances: [{ ...event.instances[0], id: "00000000-0000-4000-8000-000000000999" }],
    })).toThrow(/inconsistent/u);
  });

  it("rejects stale indexes, colliding target indexes and a mismatched inverse", () => {
    const first = instance(task(1), 101);
    const second = instance(task(2), 102);
    const before = payload([first, second]);
    const after = payload([second, first]);
    const event = createTodosEvent(before, after);

    const stale = structuredClone(event) as MutableTodosEvent;
    stale.instances[0]!.beforeIndex = 1;
    expect(() => applyTodosEvent(before, stale)).toThrow(/stale/u);

    const collision = structuredClone(event) as MutableTodosEvent;
    collision.instances[1]!.afterIndex = collision.instances[0]!.afterIndex;
    expect(() => applyTodosEvent(before, collision)).toThrow(/share an after index/u);

    expect(() => invertTodosEvent(event, before, payload([first]))).toThrow(/does not produce/u);
  });
});

type MutableTodosEvent = {
  -readonly [Key in keyof TodosEvent]: Key extends "instances"
    ? Array<{
      -readonly [Field in keyof TodosEvent["instances"][number]]:
        TodosEvent["instances"][number][Field]
    }>
    : TodosEvent[Key]
};
