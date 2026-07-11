import { validateModuleId } from "../github";
import { jsonContentKey } from "../history";
import type { ModuleDefinition } from "../sync";

export type JsonModuleDefinition<T> = Omit<ModuleDefinition<T>, "contentKey">;

/** Gives a module definition its stable public type and validates its id early. */
export function defineModule<T>(definition: ModuleDefinition<T>): ModuleDefinition<T> {
  validateModuleId(definition.moduleId);
  return Object.freeze({ ...definition });
}

/** Convenience definition for modules that deliberately use a JSON-compatible payload. */
export function defineJsonModule<T>(definition: JsonModuleDefinition<T>): ModuleDefinition<T> {
  return defineModule({
    ...definition,
    contentKey: (payload) => jsonContentKey(payload),
  });
}

export type { ModuleDefinition };
