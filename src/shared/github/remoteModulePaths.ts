import { isModuleId } from "../identifiers";
import {
  MODULE_REVISION_FILE,
  RemoteModuleFormatError,
  RemoteModulePathError,
} from "./types";

type RemotePathErrorConstructor =
  | typeof RemoteModulePathError
  | typeof RemoteModuleFormatError;

export function getModuleRoot(moduleId: string): string {
  return `data/${validateModuleId(moduleId)}`;
}

export function validateModuleId(moduleId: string): string {
  if (!isModuleId(moduleId)) {
    throw new RemoteModulePathError(
      "moduleId must contain lowercase ASCII letters or digits separated by single hyphens.",
    );
  }
  return moduleId;
}

export function getRemoteModuleRevisionPath(moduleRoot: string): string {
  return `${moduleRoot}/${MODULE_REVISION_FILE}`;
}

export function getRemoteModuleFilePath(
  moduleRoot: string,
  relativePath: string,
): string {
  return `${moduleRoot}/${relativePath}`;
}

export function validateEncodedFiles(
  files: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (!(files instanceof Map) && typeof files?.entries !== "function") {
    throw new RemoteModulePathError(
      "The module encoder must return a ReadonlyMap of text files.",
    );
  }

  const result = new Map<string, string>();
  for (const [path, fileText] of files) {
    validateRelativePath(path);
    if (typeof fileText !== "string") {
      throw new RemoteModulePathError(`Managed file content must be text: ${path}`);
    }
    result.set(path, fileText);
  }
  validatePathCollisions([...result.keys()]);
  return result;
}

export function validateManifestPaths(paths: readonly string[]): void {
  for (const path of paths) {
    validateRelativePath(path, RemoteModuleFormatError);
  }
  validatePathCollisions(paths, RemoteModuleFormatError);

  const sorted = [...paths].sort(compareRemoteModulePaths);
  if (paths.some((path, index) => path !== sorted[index])) {
    throw new RemoteModuleFormatError("revision.json managedFiles must be sorted.");
  }
}

export function validateRelativePath(
  path: string,
  ErrorType: RemotePathErrorConstructor = RemoteModulePathError,
): void {
  const invalid = typeof path !== "string"
    || path.length === 0
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || path.includes("//")
    || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split("/").some(
      (part) => part === "." || part === ".." || part.length === 0,
    )
    || path.toLocaleLowerCase("en-US") === MODULE_REVISION_FILE;

  if (invalid) {
    throw new ErrorType(`Invalid managed file path: ${String(path)}`);
  }
}

export function validatePathCollisions(
  paths: readonly string[],
  ErrorType: RemotePathErrorConstructor = RemoteModulePathError,
): void {
  const originalByCanonicalPath = new Map<string, string>();
  for (const original of paths) {
    const comparable = original.toLocaleLowerCase("en-US");
    const duplicate = originalByCanonicalPath.get(comparable);
    if (duplicate !== undefined) {
      throw new ErrorType(
        `Managed file paths collide: ${duplicate} and ${original}`,
      );
    }
    originalByCanonicalPath.set(comparable, original);
  }

  for (const [comparable, original] of originalByCanonicalPath) {
    const parts = comparable.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join("/");
      const ancestorOriginal = originalByCanonicalPath.get(ancestor);
      if (ancestorOriginal !== undefined) {
        throw new ErrorType(
          `Managed file paths collide: ${ancestorOriginal} and ${original}`,
        );
      }
    }
  }
}

export function remoteModulePathsCollide(left: string, right: string): boolean {
  const canonicalLeft = left.toLocaleLowerCase("en-US");
  const canonicalRight = right.toLocaleLowerCase("en-US");
  return canonicalLeft === canonicalRight
    || canonicalLeft.startsWith(`${canonicalRight}/`)
    || canonicalRight.startsWith(`${canonicalLeft}/`);
}

export function compareRemoteModulePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
