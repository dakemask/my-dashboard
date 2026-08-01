import { defineJsonModule } from "../shared";
import {
  applyTodosEvent,
  createEmptyTodosPayload,
  decodeTodosPayload,
  encodeTodosPayload,
  invertTodosEvent,
  validateTodosPayload,
  type TodosEvent,
  type TodosPayload,
} from "./domain";

export const todosDefinition = defineJsonModule<TodosPayload, TodosEvent>({
  moduleId: "todos",
  createEmpty: createEmptyTodosPayload,
  migration: {
    currentVersion: 1,
    migrate: () => {
      throw new TypeError("Todos has no schema migration below version 1.");
    },
  },
  validate: validateTodosPayload,
  history: {
    capacity: 200,
    apply: applyTodosEvent,
    invert: invertTodosEvent,
  },
  encode: encodeTodosPayload,
  decode: decodeTodosPayload,
});

