import {
  RemoteModuleFormatError,
  type RemoteModuleRevision,
  type RemoteRevisionSnapshot,
} from "./types";
import { validateManifestPaths } from "./remoteModulePaths";

export function parseRemoteModuleManifest(text: string): RemoteModuleRevision {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RemoteModuleFormatError("revision.json is not valid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteModuleFormatError("revision.json must contain an object.");
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.revision !== "string"
    || record.revision.length === 0
    || typeof record.updatedAt !== "string"
    || !isIsoDate(record.updatedAt)
    || !Array.isArray(record.managedFiles)
    || !record.managedFiles.every(
      (path): path is string => typeof path === "string",
    )
  ) {
    throw new RemoteModuleFormatError("revision.json has an invalid shape.");
  }

  const revision: RemoteModuleRevision = {
    revision: record.revision,
    updatedAt: record.updatedAt,
    schemaVersion: record.schemaVersion === undefined
      ? null
      : validateParsedSchemaVersion(record.schemaVersion),
    managedFiles: [...record.managedFiles],
  };
  validateManifestPaths(revision.managedFiles);
  return revision;
}

export function serializeRemoteModuleManifest(
  revision: RemoteModuleRevision,
): string {
  return `${JSON.stringify({
    revision: revision.revision,
    updatedAt: revision.updatedAt,
    ...(revision.schemaVersion === null || revision.schemaVersion === undefined
      ? {}
      : { schemaVersion: revision.schemaVersion }),
    managedFiles: revision.managedFiles,
  }, null, 2)}\n`;
}

export function validateRemoteSchemaVersion(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError("schemaVersion must be a positive safe integer.");
  }
}

export function validateRevisionToken(
  value: string | null,
  name: string,
  nullable: boolean,
): void {
  if (
    (nullable && value === null)
    || (typeof value === "string" && value.length > 0)
  ) {
    return;
  }
  throw new TypeError(
    `${name} must be ${nullable ? "null or " : ""}a non-empty string.`,
  );
}

export function isIsoDate(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function toRemoteRevisionSnapshot(
  revision: RemoteModuleRevision,
  commitSha: string,
): RemoteRevisionSnapshot {
  return {
    revision: revision.revision,
    updatedAt: revision.updatedAt,
    schemaVersion: revision.schemaVersion,
    managedFiles: [...revision.managedFiles],
    commitSha,
  };
}

function validateParsedSchemaVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RemoteModuleFormatError(
      "revision.json schemaVersion must be a positive safe integer.",
    );
  }
  return value as number;
}
