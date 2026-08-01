import { describe, expect, it } from "vitest";
import { todosDefinition } from "../../src/todos/definition";
import {
  decodeTodosPayload,
  encodeTodosPayload,
  TODOS_FILE_PATH,
} from "../../src/todos/domain";
import { instance, payload, task } from "./helpers";

describe("Todos codec", () => {
  it("defines the stable module id and schema version", () => {
    expect(todosDefinition.moduleId).toBe("todos");
    expect(todosDefinition.migration?.currentVersion).toBe(1);
  });

  it("encodes stable formatted JSON and round-trips", () => {
    const value = payload([instance(task(1))]);
    const first = encodeTodosPayload(value);
    const second = encodeTodosPayload(value);
    expect(first).toEqual(second);
    expect(first.get(TODOS_FILE_PATH)?.endsWith("\n")).toBe(true);
    expect(todosDefinition.validate(decodeTodosPayload(first))).toEqual(value);
  });

  it("rejects missing, extra and invalid managed files", () => {
    expect(() => decodeTodosPayload(new Map())).toThrow();
    expect(() => decodeTodosPayload(new Map([
      [TODOS_FILE_PATH, "{}"],
      ["extra.json", "{}"],
    ]))).toThrow();
    expect(() => decodeTodosPayload(new Map([[TODOS_FILE_PATH, "{"]]))).toThrow();
  });
});

