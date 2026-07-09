import type { PrivateDataSettings } from "../shared/privateData/types";
import {
  deleteMindMapManagedFile,
  loadMindMapLibrary,
  loadMindMapManagedFiles,
  loadMindMapUnknownFiles,
  saveMindMapFolderPlaceholder,
} from "./mindMapLibraryRepository";
import { loadMindMapDataAtPath, saveMindMapDataAtPath } from "./mindMapRepository";
import {
  collectWorkspaceMaps,
  createMindMapWorkspaceFromRemote,
  getWorkspaceDesiredFiles,
  markWorkspaceSaved,
  type MindMapWorkspace,
} from "./mindMapWorkspace";
import { normalizePath } from "./mindMapLibrary";
import type { MindMapData } from "./types";

export async function loadRemoteMindMapWorkspace(settings: PrivateDataSettings): Promise<MindMapWorkspace> {
  const [remoteEntries, managedFiles, unknownFilePaths] = await Promise.all([
    loadMindMapLibrary(settings, settings.path),
    loadMindMapManagedFiles(settings, settings.path),
    loadMindMapUnknownFiles(settings, settings.path),
  ]);
  const remoteShaByPath = new Map(managedFiles.map((file) => [file.path, file.sha]));
  const maps: Record<string, MindMapData> = {};
  const now = Date.now();

  for (const entry of collectWorkspaceMaps(remoteEntries)) {
    const result = await loadMindMapDataAtPath(settings, entry.path);

    maps[entry.path] = result.data;
    if (result.sha) {
      remoteShaByPath.set(entry.path, result.sha);
    }
  }

  return createMindMapWorkspaceFromRemote(remoteEntries, maps, remoteShaByPath, unknownFilePaths, now);
}

export async function refreshMindMapWorkspaceRemoteMetadata(
  settings: PrivateDataSettings,
  workspace: MindMapWorkspace,
): Promise<void> {
  const [managedFiles, unknownFilePaths] = await Promise.all([
    loadMindMapManagedFiles(settings, settings.path),
    loadMindMapUnknownFiles(settings, settings.path),
  ]);

  workspace.remoteShaByPath = new Map(managedFiles.map((file) => [normalizePath(file.path), file.sha]));
  workspace.remoteUnknownFilePaths = new Set(unknownFilePaths.map((path) => normalizePath(path)));
}

export async function saveRemoteMindMapWorkspace(
  settings: PrivateDataSettings,
  workspace: MindMapWorkspace,
): Promise<number> {
  const nextRemoteShaByPath = new Map(workspace.remoteShaByPath);
  const desiredPaths = new Set<string>();

  for (const file of getWorkspaceDesiredFiles(workspace)) {
    const path = normalizePath(file.path);

    desiredPaths.add(path);

    if (file.kind === "placeholder") {
      if (workspace.remoteShaByPath.has(path)) {
        continue;
      }

      nextRemoteShaByPath.set(path, await saveMindMapFolderPlaceholder(settings, file.folderPath, null));
      continue;
    }

    if (!workspace.dirtyContentPaths.has(path) && workspace.remoteShaByPath.has(path)) {
      continue;
    }

    nextRemoteShaByPath.set(
      path,
      await saveMindMapDataAtPath(
        settings,
        path,
        file.data,
        workspace.remoteShaByPath.get(path) ?? null,
        `save mind map ${path}`,
      ),
    );
  }

  for (const [path, sha] of workspace.remoteShaByPath) {
    const normalizedPath = normalizePath(path);

    if (!desiredPaths.has(normalizedPath)) {
      await deleteMindMapManagedFile(settings, normalizedPath, sha);
      nextRemoteShaByPath.delete(normalizedPath);
    }
  }

  const savedAt = Date.now();

  markWorkspaceSaved(workspace, nextRemoteShaByPath, savedAt);
  return savedAt;
}
