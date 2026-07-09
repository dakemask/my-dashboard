import {
  GitHubApiError,
  deleteTextFileAtPath,
  listDirectoryAtPath,
  updateTextFileAtPath,
  type GitHubDirectoryItem,
} from "../shared/privateData/githubContentApi";
import { getPrivateDataRevisionFileName } from "../shared/privateData/revision";
import type { PrivateDataSettings } from "../shared/privateData/types";
import {
  FOLDER_PLACEHOLDER_FILE,
  getFolderPlaceholderPath,
  joinPath,
  isMapFileName,
  normalizePath,
} from "./mindMapLibrary";
import type { MindMapLibraryEntry } from "./types";

export interface ManagedLibraryFile {
  path: string;
  sha: string;
}

interface FolderScan {
  files: ManagedLibraryFile[];
  unknownPaths: string[];
}

export async function loadMindMapLibrary(
  settings: PrivateDataSettings,
  rootPath: string,
): Promise<MindMapLibraryEntry[]> {
  try {
    return await loadDirectoryEntries(settings, rootPath, rootPath);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return [];
    }

    throw error;
  }
}

export async function loadMindMapManagedFiles(
  settings: PrivateDataSettings,
  rootPath: string,
): Promise<ManagedLibraryFile[]> {
  try {
    return (await scanManagedFolder(settings, rootPath, rootPath)).files;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return [];
    }

    throw error;
  }
}

export async function loadMindMapUnknownFiles(
  settings: PrivateDataSettings,
  rootPath: string,
): Promise<string[]> {
  try {
    return (await scanFolderFiles(settings, rootPath, rootPath)).unknownPaths;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return [];
    }

    throw error;
  }
}

export async function saveMindMapFolderPlaceholder(
  settings: PrivateDataSettings,
  folderPath: string,
  sha: string | null,
): Promise<string> {
  return updateTextFileAtPath(settings, getFolderPlaceholderPath(folderPath), {
    message: `create mind map folder ${normalizePath(folderPath)}`,
    sha,
    text: "",
  });
}

export async function deleteMindMapManagedFile(
  settings: PrivateDataSettings,
  path: string,
  sha: string,
): Promise<void> {
  const normalizedPath = normalizePath(path);

  await deleteTextFileAtPath(settings, normalizedPath, sha, `delete mind map library item ${normalizedPath}`);
}

async function loadDirectoryEntries(
  settings: PrivateDataSettings,
  directoryPath: string,
  rootPath: string,
): Promise<MindMapLibraryEntry[]> {
  const items = await listDirectoryAtPath(settings, directoryPath);
  const entries: MindMapLibraryEntry[] = [];

  for (const item of sortDirectoryItems(items)) {
    if (isRootRevisionFile(item, rootPath)) {
      continue;
    }

    if (item.type === "dir") {
      entries.push({
        kind: "folder",
        name: item.name,
        path: item.path,
        children: await loadDirectoryEntries(settings, item.path, rootPath),
      });
      continue;
    }

    if (item.type === "file" && isMapFileName(item.name)) {
      entries.push({
        kind: "map",
        name: item.name,
        path: item.path,
      });
    }
  }

  return entries;
}

async function scanManagedFolder(
  settings: PrivateDataSettings,
  folderPath: string,
  rootPath: string,
): Promise<FolderScan> {
  return scanFolderFiles(settings, folderPath, rootPath);
}

async function scanFolderFiles(
  settings: PrivateDataSettings,
  folderPath: string,
  rootPath: string,
): Promise<FolderScan> {
  const items = await listDirectoryAtPath(settings, folderPath);
  const scan: FolderScan = {
    files: [],
    unknownPaths: [],
  };

  for (const item of items) {
    if (isRootRevisionFile(item, rootPath)) {
      continue;
    }

    if (item.type === "dir") {
      const childScan = await scanFolderFiles(settings, item.path, rootPath);

      scan.files.push(...childScan.files);
      scan.unknownPaths.push(...childScan.unknownPaths);
      continue;
    }

    if (item.type === "file" && (item.name === FOLDER_PLACEHOLDER_FILE || isMapFileName(item.name))) {
      scan.files.push({
        path: item.path,
        sha: item.sha,
      });
      continue;
    }

    if (item.type === "file") {
      scan.unknownPaths.push(item.path);
    }
  }

  return scan;
}

function isRootRevisionFile(item: GitHubDirectoryItem, rootPath: string): boolean {
  return item.type === "file" && normalizePath(item.path) === joinPath(rootPath, getPrivateDataRevisionFileName());
}

function sortDirectoryItems(items: GitHubDirectoryItem[]): GitHubDirectoryItem[] {
  return [...items].sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") {
      return -1;
    }

    if (a.type !== "dir" && b.type === "dir") {
      return 1;
    }

    return a.name.localeCompare(b.name, "zh-CN");
  });
}
