import type { MindMapLibraryEntry } from "./types";

export const DEFAULT_MIND_MAP_LIBRARY_ROOT = "data/mind-maps";
export const LEGACY_MIND_MAP_FILE_PATH = "data/mind-map.json";
export const FOLDER_PLACEHOLDER_FILE = ".gitkeep";

export interface NameValidationResult {
  value: string;
  error: string | null;
}

export function normalizeMindMapLibraryRoot(path: string): string {
  const normalized = normalizePath(path);

  if (!normalized || normalized === LEGACY_MIND_MAP_FILE_PATH) {
    return DEFAULT_MIND_MAP_LIBRARY_ROOT;
  }

  return normalized;
}

export function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join("/"));
}

export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");

  return index === -1 ? "" : normalized.slice(0, index);
}

export function getBaseName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");

  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function getMapTitleFromPath(path: string): string {
  const name = getBaseName(path);

  return name.toLowerCase().endsWith(".json") ? name.slice(0, -5) : name;
}

export function getFolderPlaceholderPath(folderPath: string): string {
  return joinPath(folderPath, FOLDER_PLACEHOLDER_FILE);
}

export function isMapFileName(name: string): boolean {
  return name.toLowerCase().endsWith(".json");
}

export function getFolderNameValidation(input: string): NameValidationResult {
  const value = input.trim();

  if (!value) {
    return {
      value,
      error: "文件夹名称不能为空。",
    };
  }

  if (hasPathSeparator(value)) {
    return {
      value,
      error: "文件夹名称不能包含 / 或 \\。",
    };
  }

  if (value === "." || value === ".." || value === FOLDER_PLACEHOLDER_FILE) {
    return {
      value,
      error: "文件夹名称不可用。",
    };
  }

  return {
    value,
    error: null,
  };
}

export function getMapFileNameValidation(input: string): NameValidationResult {
  const raw = input.trim();
  const value = isMapFileName(raw) ? raw : `${raw}.json`;
  const title = isMapFileName(value) ? value.slice(0, -5).trim() : value;

  if (!title) {
    return {
      value,
      error: "导图名称不能为空。",
    };
  }

  if (hasPathSeparator(value)) {
    return {
      value,
      error: "导图名称不能包含 / 或 \\。",
    };
  }

  if (title === "." || title === "..") {
    return {
      value,
      error: "导图名称不可用。",
    };
  }

  return {
    value,
    error: null,
  };
}

export function getRelativeFolderPathValidation(input: string): NameValidationResult {
  const value = normalizePath(input);

  if (!value) {
    return {
      value,
      error: null,
    };
  }

  for (const part of value.split("/")) {
    const validation = getFolderNameValidation(part);

    if (validation.error) {
      return {
        value,
        error: validation.error,
      };
    }
  }

  return {
    value,
    error: null,
  };
}

export function findLibraryEntry(entries: MindMapLibraryEntry[], path: string): MindMapLibraryEntry | null {
  const normalized = normalizePath(path);

  for (const entry of entries) {
    if (entry.path === normalized) {
      return entry;
    }

    if (entry.kind === "folder") {
      const child = findLibraryEntry(entry.children, normalized);

      if (child) {
        return child;
      }
    }
  }

  return null;
}

export function addLibraryEntry(
  entries: MindMapLibraryEntry[],
  entry: MindMapLibraryEntry,
  rootPath: string,
): MindMapLibraryEntry[] {
  const parentPath = getParentPath(entry.path);

  if (!parentPath || parentPath === normalizePath(rootPath)) {
    return sortLibraryEntries([...entries, entry]);
  }

  return sortLibraryEntries(
    entries.map((current) => {
      if (current.kind !== "folder") {
        return current;
      }

      if (current.path === parentPath) {
        return {
          ...current,
          children: sortLibraryEntries([...current.children, entry]),
        };
      }

      return {
        ...current,
        children: addLibraryEntry(current.children, entry, rootPath),
      };
    }),
  );
}

export function removeLibraryEntry(
  entries: MindMapLibraryEntry[],
  path: string,
): MindMapLibraryEntry[] {
  const normalized = normalizePath(path);

  return entries
    .filter((entry) => entry.path !== normalized)
    .map((entry) =>
      entry.kind === "folder"
        ? {
            ...entry,
            children: removeLibraryEntry(entry.children, normalized),
          }
        : entry,
    );
}

export function updateLibraryEntryPath(entry: MindMapLibraryEntry, fromPath: string, toPath: string): MindMapLibraryEntry {
  const nextPath = replacePathPrefix(entry.path, fromPath, toPath);

  if (entry.kind === "map") {
    return {
      ...entry,
      name: getBaseName(nextPath),
      path: nextPath,
    };
  }

  return {
    ...entry,
    name: getBaseName(nextPath),
    path: nextPath,
    children: entry.children.map((child) => updateLibraryEntryPath(child, fromPath, toPath)),
  };
}

export function sortLibraryEntries(entries: MindMapLibraryEntry[]): MindMapLibraryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === "folder" && b.kind !== "folder") {
      return -1;
    }

    if (a.kind !== "folder" && b.kind === "folder") {
      return 1;
    }

    return a.name.localeCompare(b.name, "zh-CN");
  });
}

export function pathExists(entries: MindMapLibraryEntry[], path: string): boolean {
  return Boolean(findLibraryEntry(entries, path));
}

export function isPathEqualOrInside(path: string, containerPath: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedContainerPath = normalizePath(containerPath);

  return normalizedPath === normalizedContainerPath || normalizedPath.startsWith(`${normalizedContainerPath}/`);
}

export function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedFrom = normalizePath(fromPrefix);
  const normalizedTo = normalizePath(toPrefix);

  if (normalizedPath === normalizedFrom) {
    return normalizedTo;
  }

  return joinPath(normalizedTo, normalizedPath.slice(normalizedFrom.length + 1));
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}
