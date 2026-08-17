import {
  ancestorFolderPaths,
  parentPath,
  pathDepth,
  type MindMapDocument,
  type MindMapPayload,
} from "../domain";
import type { LibrarySelection } from "../library/treeView";

export interface DirtyLibraryState {
  readonly mapIds: ReadonlySet<string>;
  readonly folderPaths: ReadonlySet<string>;
}

export interface HistoryFocus {
  readonly selection: LibrarySelection;
  readonly mapIdToOpen: string | null;
}

export function computeDirtyLibraryState(
  current: MindMapPayload,
  baseline: MindMapPayload,
): DirtyLibraryState {
  const currentMaps = new Map(current.maps.map((map) => [map.id, map]));
  const baselineMaps = new Map(baseline.maps.map((map) => [map.id, map]));
  const dirtyMapIds = new Set<string>();
  const affectedFolderPaths = new Set<string>();
  const markMapPath = (path: string): void => {
    for (const folder of ancestorFolderPaths(path)) affectedFolderPaths.add(folder);
  };
  const markFolderPath = (path: string): void => {
    for (const folder of ancestorFolderPaths(path)) affectedFolderPaths.add(folder);
    affectedFolderPaths.add(path);
  };

  for (const map of current.maps) {
    const saved = baselineMaps.get(map.id);
    if (!saved || documentKey(saved) !== documentKey(map)) {
      dirtyMapIds.add(map.id);
      markMapPath(map.path);
      if (saved) markMapPath(saved.path);
    }
  }
  for (const map of baseline.maps) {
    if (!currentMaps.has(map.id)) markMapPath(map.path);
  }

  const currentFolders = new Set(current.folders);
  const baselineFolders = new Set(baseline.folders);
  for (const path of currentFolders) {
    if (!baselineFolders.has(path)) markFolderPath(path);
  }
  for (const path of baselineFolders) {
    if (!currentFolders.has(path)) markFolderPath(path);
  }

  const dirtyFolderPaths = new Set<string>();
  for (const folder of current.folders) {
    if (affectedFolderPaths.has(folder)) dirtyFolderPaths.add(folder);
  }
  return { mapIds: dirtyMapIds, folderPaths: dirtyFolderPaths };
}

/** Finds the single semantic target changed by one global undo/redo step. */
export function findHistoryFocus(before: MindMapPayload, after: MindMapPayload): HistoryFocus {
  const beforeMaps = new Map(before.maps.map((map) => [map.id, map]));
  const afterMaps = new Map(after.maps.map((map) => [map.id, map]));
  const changedMapIds = new Set<string>();
  for (const [id, map] of afterMaps) {
    const previous = beforeMaps.get(id);
    if (!previous || documentKey(previous) !== documentKey(map)) changedMapIds.add(id);
  }
  for (const id of beforeMaps.keys()) {
    if (!afterMaps.has(id)) changedMapIds.add(id);
  }

  const beforeFolderSet = new Set(before.folders);
  const afterFolderSet = new Set(after.folders);
  const removedFolders = before.folders.filter((path) => !afterFolderSet.has(path));
  const addedFolders = after.folders.filter((path) => !beforeFolderSet.has(path));
  const folderRoot = shallowestPath(addedFolders) ?? shallowestPath(removedFolders);

  if (folderRoot) {
    if (afterFolderSet.has(folderRoot)) {
      return { selection: { kind: "folder", path: folderRoot }, mapIdToOpen: null };
    }
    return {
      selection: nearestExistingParent(folderRoot, afterFolderSet),
      mapIdToOpen: null,
    };
  }

  const existingChangedMap = [...changedMapIds]
    .map((id) => afterMaps.get(id))
    .find((map): map is MindMapDocument => Boolean(map));
  if (existingChangedMap) {
    return {
      selection: { kind: "map", mapId: existingChangedMap.id },
      mapIdToOpen: existingChangedMap.id,
    };
  }

  const removedMap = [...changedMapIds]
    .map((id) => beforeMaps.get(id))
    .find((map): map is MindMapDocument => Boolean(map));
  if (removedMap) {
    return {
      selection: nearestExistingParent(parentPath(removedMap.path), afterFolderSet),
      mapIdToOpen: null,
    };
  }
  return { selection: null, mapIdToOpen: null };
}

function documentKey(map: MindMapDocument): string {
  return JSON.stringify(map);
}

function shallowestPath(paths: readonly string[]): string | null {
  return [...paths].sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right))[0] ?? null;
}

function nearestExistingParent(path: string, folders: ReadonlySet<string>): LibrarySelection {
  let candidate = path;
  while (candidate) {
    if (folders.has(candidate)) return { kind: "folder", path: candidate };
    candidate = parentPath(candidate);
  }
  return null;
}
