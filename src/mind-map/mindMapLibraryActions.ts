import { createEmptyMindMapData } from "./mindMap";
import {
  findLibraryEntry,
  getBaseName,
  getFolderNameValidation,
  getMapFileNameValidation,
  getMapTitleFromPath,
  getParentPath,
  getRelativeFolderPathValidation,
  isPathEqualOrInside,
  joinPath,
  normalizePath,
  pathExists,
  replacePathPrefix,
} from "./mindMapLibrary";
import {
  addWorkspaceFolder,
  addWorkspaceMap,
  getWorkspaceEntry,
  moveWorkspaceEntry,
  removeWorkspaceEntry,
  type MindMapWorkspace,
} from "./mindMapWorkspace";
import type { MindMapData, MindMapLibrarySelection } from "./types";

export interface MindMapLibraryActionContext {
  currentMapPath: string | null;
  rootPath: string;
  selection: MindMapLibrarySelection;
  workspace: MindMapWorkspace;
}

export type MindMapLibraryActionResult =
  | {
      changed: false;
      status?: string;
    }
  | {
      changed: true;
      currentMapPath?: string | null;
      openedMap?: {
        data: MindMapData;
        path: string;
      };
      selection: MindMapLibrarySelection;
      status: string;
    };

export function createMindMapFolderAction(context: MindMapLibraryActionContext): MindMapLibraryActionResult {
  const input = prompt("新文件夹名称");

  if (input === null) {
    return {
      changed: false,
    };
  }

  const validation = getFolderNameValidation(input);

  if (validation.error) {
    return actionError(validation.error);
  }

  const folderPath = joinPath(getSelectedDirectoryPath(context), validation.value);

  if (!isAvailablePath(context.workspace, folderPath)) {
    return actionError("同名文件或文件夹已存在。");
  }

  addWorkspaceFolder(context.workspace, context.rootPath, folderPath);

  return {
    changed: true,
    selection: {
      kind: "folder",
      path: folderPath,
    },
    status: "已在本地新建文件夹，尚未保存到 GitHub。",
  };
}

export function createMindMapFileAction(context: MindMapLibraryActionContext): MindMapLibraryActionResult {
  const input = prompt("新导图名称");

  if (input === null) {
    return {
      changed: false,
    };
  }

  const validation = getMapFileNameValidation(input);

  if (validation.error) {
    return actionError(validation.error);
  }

  const filePath = joinPath(getSelectedDirectoryPath(context), validation.value);

  if (!isAvailablePath(context.workspace, filePath)) {
    return actionError("同名文件或文件夹已存在。");
  }

  const data = createEmptyMindMapData();

  addWorkspaceMap(context.workspace, context.rootPath, filePath, data);

  return {
    changed: true,
    currentMapPath: filePath,
    openedMap: {
      data,
      path: filePath,
    },
    selection: {
      kind: "map",
      path: filePath,
    },
    status: `已在本地新建导图：${getMapTitleFromPath(filePath)}，尚未保存到 GitHub。`,
  };
}

export function renameMindMapLibraryEntryAction(context: MindMapLibraryActionContext): MindMapLibraryActionResult {
  if (!context.selection) {
    return actionError("请选择要重命名的导图或文件夹。");
  }

  const entry = getWorkspaceEntry(context.workspace, context.selection.path);

  if (!entry) {
    return actionError("请选择要重命名的导图或文件夹。");
  }

  if (entry.kind === "folder" && !folderHasOnlyManagedRemoteFiles(context.workspace, entry.path)) {
    return unknownFileError(context.workspace, entry.path);
  }

  const input = prompt("新名称", entry.kind === "map" ? getMapTitleFromPath(entry.path) : entry.name);

  if (input === null) {
    return {
      changed: false,
    };
  }

  const validation = entry.kind === "map" ? getMapFileNameValidation(input) : getFolderNameValidation(input);

  if (validation.error) {
    return actionError(validation.error);
  }

  const nextPath = joinPath(getParentPath(entry.path), validation.value);

  if (nextPath === entry.path) {
    return {
      changed: false,
    };
  }

  if (!isAvailablePath(context.workspace, nextPath)) {
    return actionError("同名文件或文件夹已存在。");
  }

  moveWorkspaceEntry(context.workspace, entry, nextPath, context.rootPath);

  return {
    changed: true,
    currentMapPath: getMovedCurrentMapPath(context.currentMapPath, entry.path, nextPath),
    selection: {
      kind: entry.kind,
      path: nextPath,
    },
    status: entry.kind === "map" ? "已在本地重命名导图，尚未保存到 GitHub。" : "已在本地重命名文件夹，尚未保存到 GitHub。",
  };
}

export function moveMindMapLibraryEntryAction(context: MindMapLibraryActionContext): MindMapLibraryActionResult {
  if (!context.selection) {
    return actionError("请选择要移动的导图或文件夹。");
  }

  const entry = getWorkspaceEntry(context.workspace, context.selection.path);

  if (!entry) {
    return actionError("请选择要移动的导图或文件夹。");
  }

  if (entry.kind === "folder" && !folderHasOnlyManagedRemoteFiles(context.workspace, entry.path)) {
    return unknownFileError(context.workspace, entry.path);
  }

  const targetFolder = getExistingTargetFolderPath(context, getRelativePath(getParentPath(entry.path), context.rootPath));

  if (targetFolder === null) {
    return {
      changed: false,
    };
  }

  if ("status" in targetFolder) {
    return actionError(targetFolder.status);
  }

  const targetFolderPath = targetFolder.path;

  if (entry.kind === "folder" && isPathEqualOrInside(targetFolderPath, entry.path)) {
    return actionError("文件夹不能移动到自己或自己的子文件夹。");
  }

  const nextPath = joinPath(targetFolderPath, getBaseName(entry.path));

  if (nextPath === entry.path) {
    return actionError("位置没有变化。");
  }

  if (!isAvailablePath(context.workspace, nextPath)) {
    return actionError("同名文件或文件夹已存在。");
  }

  moveWorkspaceEntry(context.workspace, entry, nextPath, context.rootPath);

  return {
    changed: true,
    currentMapPath: getMovedCurrentMapPath(context.currentMapPath, entry.path, nextPath),
    selection: {
      kind: entry.kind,
      path: nextPath,
    },
    status: entry.kind === "map" ? "已在本地移动导图，尚未保存到 GitHub。" : "已在本地移动文件夹，尚未保存到 GitHub。",
  };
}

export function deleteMindMapLibraryEntryAction(context: MindMapLibraryActionContext): MindMapLibraryActionResult {
  if (!context.selection) {
    return actionError("请选择要删除的导图或文件夹。");
  }

  const entry = getWorkspaceEntry(context.workspace, context.selection.path);

  if (!entry) {
    return actionError("请选择要删除的导图或文件夹。");
  }

  if (entry.kind === "folder" && !folderHasOnlyManagedRemoteFiles(context.workspace, entry.path)) {
    return unknownFileError(context.workspace, entry.path);
  }

  const label = entry.kind === "map" ? `导图“${getMapTitleFromPath(entry.path)}”` : `文件夹“${entry.name}”及其中所有导图`;
  const ok = confirm(`确定删除${label}吗？此操作会删除 GitHub 仓库中的对应文件。`);

  if (!ok) {
    return {
      changed: false,
    };
  }

  removeWorkspaceEntry(context.workspace, entry);

  return {
    changed: true,
    currentMapPath:
      context.currentMapPath && isPathEqualOrInside(context.currentMapPath, entry.path)
        ? null
        : context.currentMapPath,
    selection: null,
    status: "已在本地删除，尚未保存到 GitHub。",
  };
}

function actionError(status: string): MindMapLibraryActionResult {
  return {
    changed: false,
    status,
  };
}

function folderHasOnlyManagedRemoteFiles(workspace: MindMapWorkspace, folderPath: string): boolean {
  return ![...workspace.remoteUnknownFilePaths].some((path) => isPathEqualOrInside(path, folderPath));
}

function getExistingTargetFolderPath(
  context: MindMapLibraryActionContext,
  initialPath: string,
): { path: string } | { status: string } | null {
  const input = prompt("输入目标文件夹路径（相对于导图库根目录，留空表示根目录）", initialPath);

  if (input === null) {
    return null;
  }

  const validation = getRelativeFolderPathValidation(input);

  if (validation.error) {
    return {
      status: validation.error,
    };
  }

  const targetPath = validation.value ? joinPath(context.rootPath, validation.value) : context.rootPath;
  const entry = findLibraryEntry(context.workspace.tree, targetPath);

  if (targetPath !== context.rootPath && entry?.kind !== "folder") {
    return {
      status: "目标文件夹不存在。",
    };
  }

  return {
    path: targetPath,
  };
}

function getMovedCurrentMapPath(currentMapPath: string | null, fromPath: string, toPath: string): string | undefined {
  if (!currentMapPath || !isPathEqualOrInside(currentMapPath, fromPath)) {
    return undefined;
  }

  return replacePathPrefix(currentMapPath, fromPath, toPath);
}

function getRelativePath(path: string, rootPath: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedRootPath = normalizePath(rootPath);

  if (normalizedPath === normalizedRootPath) {
    return "";
  }

  return normalizedPath.startsWith(`${normalizedRootPath}/`)
    ? normalizedPath.slice(normalizedRootPath.length + 1)
    : normalizedPath;
}

function getSelectedDirectoryPath(context: MindMapLibraryActionContext): string {
  if (!context.selection) {
    return context.rootPath;
  }

  if (context.selection.kind === "folder") {
    return context.selection.path;
  }

  return getParentPath(context.selection.path) || context.rootPath;
}

function isAvailablePath(workspace: MindMapWorkspace, path: string): boolean {
  return !pathExists(workspace.tree, path);
}

function unknownFileError(workspace: MindMapWorkspace, folderPath: string): MindMapLibraryActionResult {
  const unknownPath = [...workspace.remoteUnknownFilePaths].find((path) => isPathEqualOrInside(path, folderPath));

  return actionError(`文件夹中包含非导图库管理文件，已阻止操作：${unknownPath ?? folderPath}`);
}
