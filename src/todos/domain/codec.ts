import { validateTodosPayload } from "./model";
import type { TodosPayload } from "./types";

export const TODOS_FILE_PATH = "todos.json";

export function encodeTodosPayload(value: TodosPayload): ReadonlyMap<string, string> {
  const payload = validateTodosPayload(value);
  return new Map([[TODOS_FILE_PATH, `${JSON.stringify(payload, null, 2)}\n`]]);
}

export function decodeTodosPayload(files: ReadonlyMap<string, string>): unknown {
  if (!files || typeof files.entries !== "function") {
    throw new TypeError("Todos files must be a ReadonlyMap.");
  }
  const entries = [...files.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== TODOS_FILE_PATH) {
    throw new TypeError(`Todos must contain only ${TODOS_FILE_PATH}.`);
  }
  try {
    return JSON.parse(entries[0][1]) as unknown;
  } catch {
    throw new TypeError("Todos file is not valid JSON.");
  }
}

