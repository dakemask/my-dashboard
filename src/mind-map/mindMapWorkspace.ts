import { createEmptyMindMapData } from "./mindMap";
import {
  addLibraryEntry,
  findLibraryEntry,
  getBaseName,
  getFolderPlaceholderPath,
  isPathEqualOrInside,
  normalizePath,
  removeLibraryEntry,
  replacePathPrefix,
  updateLibraryEntryPath,
} from "./mindMapLibrary";
import type { MindMapData, MindMapLibraryEntry } from "./types";

export interface MindMapWorkspace {
  tree: MindMapLibraryEntry[];
  maps: Record<string, MindMapData>;
  dirtyContentPaths: Set<string>;
  dirtyTree: boolean;
  treeChangePaths: Set<string>;
  remoteShaByPath: Map<string, string>;
  remoteUnknownFilePaths: Set<string>;
  lastRemoteRefreshAt: number | null;
}

export interface MindMapWorkspaceSnapshot {
  tree: MindMapLibraryEntry[];
  maps: Record<string, MindMapData>;
  dirtyContentPaths: string[];
  dirtyTree: boolean;
  treeChangePaths: string[];
  remoteShaByPath: Record<string, string>;
  remoteUnknownFilePaths: string[];
  lastRemoteRefreshAt: number | null;
}

export interface MindMapWorkspaceStoredSnapshot {
  tree?: MindMapLibraryEntry[];
  entries?: MindMapLibraryEntry[];
  maps?: Record<string, MindMapData | LegacyCachedMap>;
  dirtyContentPaths?: string[];
  dirtyMapPaths?: string[];
  dirtyTree?: boolean;
  libraryDirty?: boolean;
  treeChangePaths?: string[];
  remoteShaByPath?: Record<string, string>;
  remoteUnknownFilePaths?: string[];
  lastRemoteRefreshAt?: number | null;
}

interface LegacyCachedMap {
  path?: string;
  data: MindMapData;
  sha?: string | null;
  updatedAt?: number;
}

export interface WorkspaceDesiredMapFile {
  kind: "map";
  path: string;
  data: MindMapData;
}

export interface WorkspaceDesiredPlaceholderFile {
  kind: "placeholder";
  path: string;
  folderPath: string;
}

export type WorkspaceDesiredFile = WorkspaceDesiredMapFile | WorkspaceDesiredPlaceholderFile;

export function createEmptyMindMapWorkspace(): MindMapWorkspace {
  return {
    tree: [],
    maps: {},
    dirtyContentPaths: new Set(),
    dirtyTree: false,
    treeChangePaths: new Set(),
    remoteShaByPath: new Map(),
    remoteUnknownFilePaths: new Set(),
    lastRemoteRefreshAt: null,
  };
}

export function createMindMapWorkspaceFromRemote(
  tree: MindMapLibraryEntry[],
  maps: Record<string, MindMapData>,
  remoteShaByPath: Map<string, string>,
  remoteUnknownFilePaths: Iterable<string>,
  refreshedAt: number,
): MindMapWorkspace {
  return {
    tree: normalizeWorkspaceTree(tree),
    maps: normalizeWorkspaceMaps(maps),
    dirtyContentPaths: new Set(),
    dirtyTree: false,
    treeChangePaths: new Set(),
    remoteShaByPath: normalizeShaMap(remoteShaByPath),
    remoteUnknownFilePaths: normalizePathSet(remoteUnknownFilePaths),
    lastRemoteRefreshAt: refreshedAt,
  };
}

export function createMindMapWorkspaceFromSnapshot(snapshot: MindMapWorkspaceStoredSnapshot): MindMapWorkspace {
  const tree = normalizeWorkspaceTree(snapshot.tree ?? snapshot.entries ?? []);
  const maps: Record<string, MindMapData> = {};
  const remoteShaByPath = new Map<string, string>(
    Object.entries(snapshot.remoteShaByPath ?? {}).map(([path, sha]) => [normalizePath(path), sha]),
  );

  for (const [path, value] of Object.entries(snapshot.maps ?? {})) {
    const normalizedPath = normalizePath(path);

    if (isLegacyCachedMap(value)) {
      maps[normalizedPath] = value.data;

      if (typeof value.sha === "string" && value.sha) {
        remoteShaByPath.set(normalizedPath, value.sha);
      }
    } else {
      maps[normalizedPath] = value;
    }
  }

  collectLegacyEntrySha(snapshot.tree ?? snapshot.entries ?? [], remoteShaByPath);

  return {
    tree,
    maps,
    dirtyContentPaths: normalizePathSet(snapshot.dirtyContentPaths ?? snapshot.dirtyMapPaths ?? []),
    dirtyTree: snapshot.dirtyTree ?? snapshot.libraryDirty ?? false,
    treeChangePaths: normalizePathSet(snapshot.treeChangePaths ?? collectLegacyPendingPaths(snapshot.tree ?? snapshot.entries ?? [])),
    remoteShaByPath,
    remoteUnknownFilePaths: normalizePathSet(snapshot.remoteUnknownFilePaths ?? []),
    lastRemoteRefreshAt: snapshot.lastRemoteRefreshAt ?? null,
  };
}

export function createMindMapWorkspaceSnapshot(workspace: MindMapWorkspace): MindMapWorkspaceSnapshot {
  return {
    tree: normalizeWorkspaceTree(workspace.tree),
    maps: normalizeWorkspaceMaps(workspace.maps),
    dirtyContentPaths: [...workspace.dirtyContentPaths],
    dirtyTree: workspace.dirtyTree,
    treeChangePaths: [...workspace.treeChangePaths],
    remoteShaByPath: Object.fromEntries(workspace.remoteShaByPath),
    remoteUnknownFilePaths: [...workspace.remoteUnknownFilePaths],
    lastRemoteRefreshAt: workspace.lastRemoteRefreshAt,
  };
}

export function hasWorkspaceChanges(workspace: MindMapWorkspace): boolean {
  return workspace.dirtyContentPaths.size > 0 || workspace.dirtyTree;
}

export function getWorkspaceEntry(workspace: MindMapWorkspace, path: string): MindMapLibraryEntry | null {
  return findLibraryEntry(workspace.tree, normalizePath(path));
}

export function getWorkspaceMapData(workspace: MindMapWorkspace, path: string): MindMapData | null {
  return workspace.maps[normalizePath(path)] ?? null;
}

export function cacheWorkspaceMapData(workspace: MindMapWorkspace, path: string, data: MindMapData): void {
  workspace.maps[normalizePath(path)] = data;
}

export function updateWorkspaceMapData(workspace: MindMapWorkspace, path: string, data: MindMapData): void {
  const normalizedPath = normalizePath(path);

  workspace.maps[normalizedPath] = data;
  workspace.dirtyContentPaths.add(normalizedPath);
}

export function addWorkspaceFolder(workspace: MindMapWorkspace, rootPath: string, folderPath: string): void {
  const normalizedPath = normalizePath(folderPath);

  workspace.tree = addLibraryEntry(
    workspace.tree,
    {
      kind: "folder",
      name: getBaseName(normalizedPath),
      path: normalizedPath,
      children: [],
    },
    rootPath,
  );
  markWorkspaceTreeChanged(workspace, normalizedPath);
}

export function addWorkspaceMap(
  workspace: MindMapWorkspace,
  rootPath: string,
  mapPath: string,
  data: MindMapData = createEmptyMindMapData(),
): void {
  const normalizedPath = normalizePath(mapPath);

  workspace.tree = addLibraryEntry(
    workspace.tree,
    {
      kind: "map",
      name: getBaseName(normalizedPath),
      path: normalizedPath,
    },
    rootPath,
  );
  workspace.maps[normalizedPath] = data;
  markWorkspaceTreeChanged(workspace, normalizedPath);
}

export function moveWorkspaceEntry(
  workspace: MindMapWorkspace,
  entry: MindMapLibraryEntry,
  nextPath: string,
  rootPath: string,
): void {
  const normalizedNextPath = normalizePath(nextPath);
  const updatedEntry = updateLibraryEntryPath(entry, entry.path, normalizedNextPath);

  workspace.tree = addLibraryEntry(removeLibraryEntry(workspace.tree, entry.path), updatedEntry, rootPath);
  moveWorkspaceMapsPrefix(workspace, entry.path, normalizedNextPath);
  moveWorkspaceDirtyContentPrefix(workspace, entry.path, normalizedNextPath);
  moveWorkspaceTreeChangePrefix(workspace, entry.path, normalizedNextPath);
  markWorkspaceTreeChanged(workspace, normalizedNextPath);
}

export function removeWorkspaceEntry(workspace: MindMapWorkspace, entry: MindMapLibraryEntry): void {
  workspace.tree = removeLibraryEntry(workspace.tree, entry.path);
  removeWorkspaceMapsPrefix(workspace, entry.path);
  removeWorkspaceDirtyContentPrefix(workspace, entry.path);
  removeWorkspaceTreeChangePrefix(workspace, entry.path);
  markWorkspaceTreeChanged(workspace, entry.path);
}

export function markWorkspaceSaved(workspace: MindMapWorkspace, remoteShaByPath: Map<string, string>, savedAt: number): void {
  workspace.remoteShaByPath = normalizeShaMap(remoteShaByPath);
  workspace.dirtyContentPaths.clear();
  workspace.dirtyTree = false;
  workspace.treeChangePaths.clear();
  workspace.lastRemoteRefreshAt = savedAt;
}

export function getWorkspaceDesiredFiles(workspace: MindMapWorkspace): WorkspaceDesiredFile[] {
  const desiredFiles: WorkspaceDesiredFile[] = [];

  for (const folder of collectWorkspaceFolders(workspace.tree)) {
    if (folder.children.length === 0) {
      desiredFiles.push({
        kind: "placeholder",
        path: getFolderPlaceholderPath(folder.path),
        folderPath: folder.path,
      });
    }
  }

  for (const map of collectWorkspaceMaps(workspace.tree)) {
    desiredFiles.push({
      kind: "map",
      path: map.path,
      data: workspace.maps[map.path] ?? createEmptyMindMapData(),
    });
  }

  return desiredFiles;
}

export function collectWorkspaceMaps(entries: MindMapLibraryEntry[]): Extract<MindMapLibraryEntry, { kind: "map" }>[] {
  const maps: Extract<MindMapLibraryEntry, { kind: "map" }>[] = [];

  for (const entry of entries) {
    if (entry.kind === "map") {
      maps.push(entry);
    } else {
      maps.push(...collectWorkspaceMaps(entry.children));
    }
  }

  return maps;
}

export function collectWorkspaceFolders(entries: MindMapLibraryEntry[]): Extract<MindMapLibraryEntry, { kind: "folder" }>[] {
  const folders: Extract<MindMapLibraryEntry, { kind: "folder" }>[] = [];

  for (const entry of entries) {
    if (entry.kind === "folder") {
      folders.push(entry, ...collectWorkspaceFolders(entry.children));
    }
  }

  return folders;
}

function markWorkspaceTreeChanged(workspace: MindMapWorkspace, path: string): void {
  workspace.dirtyTree = true;
  workspace.treeChangePaths.add(normalizePath(path));
}

function moveWorkspaceMapsPrefix(workspace: MindMapWorkspace, fromPath: string, toPath: string): void {
  const nextMaps: Record<string, MindMapData> = {};

  for (const [path, data] of Object.entries(workspace.maps)) {
    nextMaps[isPathEqualOrInside(path, fromPath) ? replacePathPrefix(path, fromPath, toPath) : normalizePath(path)] = data;
  }

  workspace.maps = nextMaps;
}

function removeWorkspaceMapsPrefix(workspace: MindMapWorkspace, path: string): void {
  const nextMaps: Record<string, MindMapData> = {};

  for (const [mapPath, data] of Object.entries(workspace.maps)) {
    if (!isPathEqualOrInside(mapPath, path)) {
      nextMaps[normalizePath(mapPath)] = data;
    }
  }

  workspace.maps = nextMaps;
}

function moveWorkspaceDirtyContentPrefix(workspace: MindMapWorkspace, fromPath: string, toPath: string): void {
  const nextDirtyPaths = new Set<string>();

  for (const path of workspace.dirtyContentPaths) {
    nextDirtyPaths.add(isPathEqualOrInside(path, fromPath) ? replacePathPrefix(path, fromPath, toPath) : normalizePath(path));
  }

  workspace.dirtyContentPaths = nextDirtyPaths;
}

function removeWorkspaceDirtyContentPrefix(workspace: MindMapWorkspace, path: string): void {
  workspace.dirtyContentPaths = new Set(
    [...workspace.dirtyContentPaths].filter((dirtyPath) => !isPathEqualOrInside(dirtyPath, path)).map((dirtyPath) => normalizePath(dirtyPath)),
  );
}

function moveWorkspaceTreeChangePrefix(workspace: MindMapWorkspace, fromPath: string, toPath: string): void {
  const nextTreeChangePaths = new Set<string>();

  for (const path of workspace.treeChangePaths) {
    nextTreeChangePaths.add(isPathEqualOrInside(path, fromPath) ? replacePathPrefix(path, fromPath, toPath) : normalizePath(path));
  }

  workspace.treeChangePaths = nextTreeChangePaths;
}

function removeWorkspaceTreeChangePrefix(workspace: MindMapWorkspace, path: string): void {
  workspace.treeChangePaths = new Set(
    [...workspace.treeChangePaths]
      .filter((treePath) => !isPathEqualOrInside(treePath, path))
      .map((treePath) => normalizePath(treePath)),
  );
}

function normalizeWorkspaceTree(entries: MindMapLibraryEntry[]): MindMapLibraryEntry[] {
  return entries.map((entry) => {
    const normalizedPath = normalizePath(entry.path);

    if (entry.kind === "map") {
      return {
        kind: "map",
        name: getBaseName(normalizedPath),
        path: normalizedPath,
      };
    }

    return {
      kind: "folder",
      name: getBaseName(normalizedPath),
      path: normalizedPath,
      children: normalizeWorkspaceTree(entry.children),
    };
  });
}

function normalizeWorkspaceMaps(maps: Record<string, MindMapData>): Record<string, MindMapData> {
  return Object.fromEntries(Object.entries(maps).map(([path, data]) => [normalizePath(path), data]));
}

function normalizePathSet(paths: Iterable<string>): Set<string> {
  return new Set([...paths].map((path) => normalizePath(path)));
}

function normalizeShaMap(shaByPath: Map<string, string>): Map<string, string> {
  return new Map([...shaByPath].map(([path, sha]) => [normalizePath(path), sha]));
}

function isLegacyCachedMap(value: MindMapData | LegacyCachedMap): value is LegacyCachedMap {
  return Boolean(value && typeof value === "object" && "data" in value);
}

function collectLegacyEntrySha(entries: MindMapLibraryEntry[], remoteShaByPath: Map<string, string>): void {
  for (const entry of entries) {
    if (entry.kind === "folder") {
      collectLegacyEntrySha(entry.children, remoteShaByPath);
      continue;
    }

    const sha = (entry as { sha?: unknown }).sha;

    if (typeof sha === "string" && sha) {
      remoteShaByPath.set(normalizePath(entry.path), sha);
    }
  }
}

function collectLegacyPendingPaths(entries: MindMapLibraryEntry[]): string[] {
  const pendingPaths: string[] = [];

  for (const entry of entries) {
    if ((entry as { pending?: unknown }).pending === true) {
      pendingPaths.push(normalizePath(entry.path));
    }

    if (entry.kind === "folder") {
      pendingPaths.push(...collectLegacyPendingPaths(entry.children));
    }
  }

  return pendingPaths;
}
