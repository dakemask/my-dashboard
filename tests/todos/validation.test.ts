import { describe, expect, it } from "vitest";
import {
  validateTodoTask,
  validateTodosPayload,
} from "../../src/todos/domain/validation";
import * as domainBarrel from "../../src/todos/domain";
import * as legacyModel from "../../src/todos/domain/model";
import { id, instance, payload, rule, task } from "./helpers";

describe("Todos validation", () => {
  it("keeps the old model entry point as a validation facade", () => {
    const value = payload([instance(task(1))]);
    expect(legacyModel.validateTodosPayload(value)).toEqual(validateTodosPayload(value));
    for (const name of [
      "createEmptyTodosPayload",
      "validateTodoInstance",
      "validateTodoRule",
      "validateTodoTask",
      "validateTodosPayload",
      "validateTodosEvent",
      "effectiveWeights",
      "findTask",
      "isTaskComplete",
      "taskProgress",
      "visitTask",
    ] as const) {
      expect(typeof legacyModel[name], `legacy model export ${name}`).toBe("function");
      expect(typeof domainBarrel[name], `domain barrel export ${name}`).toBe("function");
    }
  });

  it("normalizes names and negative weights without mutating the input", () => {
    const value = task(1, {
      name: "  标题  ",
      children: [task(2, { weight: -8 })],
    });
    const snapshot = structuredClone(value);
    const valid = validateTodoTask(value, true);
    expect(valid.name).toBe("标题");
    expect(valid.children[0]?.weight).toBe(-1);
    expect(value).toEqual(snapshot);
  });

  it("rejects extra fields, duplicate ids and invalid sibling chains", () => {
    expect(() => validateTodosPayload({ ...payload(), extra: true })).toThrow(/extra fields/u);
    expect(() => validateTodosPayload(payload(
      [instance(task(1), 100)],
      [rule(task(1), 200)],
    ))).toThrow(/Duplicate Todo id/u);
    expect(() => validateTodoTask(task(1, {
      children: [
        task(2, { predecessorId: id(3) }),
        task(3, { predecessorId: id(2) }),
      ],
    }), true)).toThrow(/cycles/u);
  });

  it("validates completion and source pairing without narrowing schema-v1 date records", () => {
    expect(() => validateTodosPayload(payload([{
      ...instance(task(1)),
      completedAt: "2026-08-01T01:00:00.000Z",
    }]))).toThrow(/completion time/u);
    expect(() => validateTodosPayload(payload([{
      ...instance(task(1)),
      sourceRuleId: id(200),
    }]))).toThrow(/both exist/u);
    const legacyDateRecord = payload([{
      ...instance(task(1)),
      reminderAt: "2026-08-02T00:00:00.000Z",
      deadlineAt: "2026-08-01T00:00:00.000Z",
    }]);
    expect(validateTodosPayload(legacyDateRecord)).toEqual(legacyDateRecord);
  });

  it("validates concrete sibling weights and template completion recursively", () => {
    expect(() => validateTodoTask(task(1, {
      children: [task(2, { weight: 0.2 }), task(3, { weight: 0.7 })],
    }), true)).toThrow(/add up to one/u);
    expect(() => validateTodosPayload(payload([], [rule(task(1, {
      children: [task(2, { completed: true })],
    }))]))).toThrow(/Templates/u);
  });
});
