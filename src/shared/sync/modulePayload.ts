import { hashContentKey } from "./contentHash";
import {
  MissingModuleSchemaVersionError,
  ModuleMigrationError,
  UnsupportedModuleSchemaVersionError,
  type ModuleMigrationPolicy,
} from "./types";

export interface ModulePayloadDefinition<TPayload> {
  validate(value: unknown): TPayload;
  contentKey(payload: TPayload): string;
  readonly migration?: ModuleMigrationPolicy;
}

export type StoredModulePayloadSource = "local" | "remote";

export interface PreparedModulePayload<TPayload> {
  readonly payload: TPayload;
  readonly migrated: boolean;
  readonly fromVersion: number | null;
  readonly toVersion: number | null;
}

/**
 * Validates and isolates a payload produced by current module code. Calling
 * validate a second time across a clone boundary catches definitions that only
 * return an apparently valid value containing non-clone-safe nested data.
 */
export function prepareCurrentModulePayload<TPayload>(
  definition: ModulePayloadDefinition<TPayload>,
  value: unknown,
): TPayload {
  const payload = structuredClone(definition.validate(value));
  definition.validate(structuredClone(payload));
  getModuleContentKey(definition, payload);
  return payload;
}

/**
 * Brings a stored payload to the current business schema without mutating the
 * stored input. A versioned definition must always receive an explicit source
 * version; Shared never guesses that legacy data is version one.
 */
export function prepareStoredModulePayload<TPayload>(
  definition: ModulePayloadDefinition<TPayload>,
  value: unknown,
  sourceVersion: number | null,
  source: StoredModulePayloadSource,
): PreparedModulePayload<TPayload> {
  const policy = definition.migration;
  if (!policy) {
    return {
      payload: prepareCurrentModulePayload(definition, value),
      migrated: false,
      fromVersion: null,
      toVersion: null,
    };
  }

  if (sourceVersion === null) {
    throw new MissingModuleSchemaVersionError(source);
  }
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    throw new ModuleMigrationError(
      "Stored schemaVersion must be a positive safe integer.",
    );
  }
  if (sourceVersion > policy.currentVersion) {
    throw new UnsupportedModuleSchemaVersionError(
      sourceVersion,
      policy.currentVersion,
    );
  }

  let current = structuredClone(value);
  let version = sourceVersion;
  while (version < policy.currentVersion) {
    current = structuredClone(
      policy.migrate(structuredClone(current), version),
    );
    version += 1;
  }

  return {
    payload: prepareCurrentModulePayload(definition, current),
    migrated: sourceVersion !== policy.currentVersion,
    fromVersion: sourceVersion,
    toVersion: policy.currentVersion,
  };
}

export function getModuleContentKey<TPayload>(
  definition: ModulePayloadDefinition<TPayload>,
  payload: TPayload,
): string {
  const key = definition.contentKey(structuredClone(payload));
  if (typeof key !== "string") {
    throw new TypeError("ModuleDefinition.contentKey must return a string.");
  }
  return key;
}

export function hashModulePayload<TPayload>(
  definition: ModulePayloadDefinition<TPayload>,
  payload: TPayload,
): Promise<string> {
  return hashContentKey(getModuleContentKey(definition, payload));
}
