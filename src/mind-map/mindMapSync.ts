import type { PrivateDataSettings } from "../shared/privateData/types";
import {
  deleteMindMapManagedFile,
  loadMindMapLibrary,
  loadMindMapManagedFiles,
  loadMindMapUnknownFiles,
  saveMindMapFolderPlaceholder,
} from "./mindMapLibraryRepository";
import { loadMindMapLocalSnapshot, saveMindMapLocalSnapshot } from "./mindMapLocalStore";
import { loadMindMapDataAtPath, saveMindMapDataAtPath } from "./mindMapRepository";
import {
  collectWorkspaceMaps,
  createMindMapWorkspaceFromRemote,
  createMindMapWorkspaceFromSnapshot,
  createMindMapWorkspaceSnapshot,
  getWorkspaceDesiredFiles,
  markWorkspaceSaved,
  type MindMapWorkspace,
} from "./mindMapWorkspace";
import type { MindMapData } from "./types";

export async function loadLocalMindMapWorkspace(settings: PrivateDataSettings): Promise<MindMapWorkspace | null> {
  const snapshot = await loadMindMapLocalSnapshot(settings);

  return snapshot ? createMindMapWorkspaceFromSnapshot(snapshot) : null;
}

export function saveLocalMindMapWorkspace(
  settings: PrivateDataSettings,
  workspace: MindMapWorkspace,
): Promise<void> {
  return saveMindMapLocalSnapshot(settings, {
    rootPath: settings.path,
    ...createMindMapWorkspaceSnapshot(workspace),
    updatedAt: Date.now(),
  });
}

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

export async function saveRemoteMindMapWorkspace(
  settings: PrivateDataSettings,
  workspace: MindMapWorkspace,
): Promise<number> {
  const nextRemoteShaByPath = new Map(workspace.remoteShaByPath);
  const desiredPaths = new Set<string>();

  for (const file of getWorkspaceDesiredFiles(workspace)) {
    desiredPaths.add(file.path);

    if (file.kind === "placeholder") {
      if (workspace.remoteShaByPath.has(file.path)) {
        continue;
      }

      nextRemoteShaByPath.set(file.path, await saveMindMapFolderPlaceholder(settings, file.folderPath, null));
      continue;
    }

    if (!workspace.dirtyContentPaths.has(file.path) && workspace.remoteShaByPath.has(file.path)) {
      continue;
    }

    nextRemoteShaByPath.set(
      file.path,
      await saveMindMapDataAtPath(
        settings,
        file.path,
        file.data,
        workspace.remoteShaByPath.get(file.path) ?? null,
        `save mind map ${file.path}`,
      ),
    );
  }

  for (const [path, sha] of workspace.remoteShaByPath) {
    if (!desiredPaths.has(path)) {
      await deleteMindMapManagedFile(settings, path, sha);
      nextRemoteShaByPath.delete(path);
    }
  }

  const savedAt = Date.now();

  markWorkspaceSaved(workspace, nextRemoteShaByPath, savedAt);
  return savedAt;
}
