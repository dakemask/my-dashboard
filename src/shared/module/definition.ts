import { validateModuleId } from "../github";
import { jsonContentKey } from "../history";
import type { ModuleDefinition } from "../sync";

export type JsonModuleDefinition<TPayload, TEvent> = Omit<
  ModuleDefinition<TPayload, TEvent>,
  "contentKey"
>;

/** Gives a module definition its stable public type and validates its id early. */
export function defineModule<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
): ModuleDefinition<TPayload, TEvent> {
  validateModuleId(definition.moduleId);
  const history = definition.history;
  if (
    !history
    || typeof history.apply !== "function"
    || typeof history.invert !== "function"
  ) {
    throw new TypeError("A module history policy with apply and invert functions is required.");
  }
  if (
    history.capacity !== "unlimited"
    && (!Number.isInteger(history.capacity) || history.capacity < 1)
  ) {
    throw new RangeError(
      'History capacity must be a positive integer or "unlimited".',
    );
  }
  const migration = definition.migration;
  if (migration) {
    if (
      !Number.isSafeInteger(migration.currentVersion)
      || migration.currentVersion < 1
    ) {
      throw new RangeError("Migration currentVersion must be a positive safe integer.");
    }
    if (
      typeof migration.readVersion !== "function"
      || typeof migration.migrate !== "function"
    ) {
      throw new TypeError(
        "A migration policy with readVersion and migrate functions is required.",
      );
    }
  }
  return Object.freeze({
    ...definition,
    history: Object.freeze({ ...history }),
    ...(migration ? { migration: Object.freeze({ ...migration }) } : {}),
  });
}

/** Convenience definition for modules that deliberately use a JSON-compatible payload. */
export function defineJsonModule<TPayload, TEvent>(
  definition: JsonModuleDefinition<TPayload, TEvent>,
): ModuleDefinition<TPayload, TEvent> {
  return defineModule({
    ...definition,
    contentKey: (payload) => jsonContentKey(payload),
  });
}

export type { ModuleDefinition };
