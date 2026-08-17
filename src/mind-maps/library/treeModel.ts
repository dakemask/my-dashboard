import {
  baseName,
  compareDisplayNames,
  compareLogicalPaths,
  parentPath,
  pathDepth,
  samePath,
  type MindMapPayload,
} from "../domain";
import type { LibraryDraft, LibrarySelection } from "./types";

export interface LibraryMapNode {
  readonly id: string;
  readonly path: string;
  readonly name: string;
}

export interface FolderTreeNode {
  readonly path: string;
  readonly name: string;
  readonly folders: readonly FolderTreeNode[];
  readonly maps: readonly LibraryMapNode[];
}

interface MutableFolder {
  path: string;
  name: string;
  folders: MutableFolder[];
  maps: LibraryMapNode[];
}

export function buildLibraryTree(payload: MindMapPayload): FolderTreeNode {
  const root: MutableFolder = { path: "", name: "", folders: [], maps: [] };
  const byPath = new Map<string, MutableFolder>([["", root]]);
  for (const path of [...payload.folders].sort(comparePath)) {
    const parent = parentPath(path);
    const folder: MutableFolder = { path, name: baseName(path), folders: [], maps: [] };
    byPath.set(path, folder);
    byPath.get(parent)?.folders.push(folder);
  }
  for (const map of payload.maps) {
    byPath.get(parentPath(map.path))?.maps.push({
      id: map.id,
      path: map.path,
      name: baseName(map.path),
    });
  }
  sortFolder(root);
  return root;
}

export function findFolderNode(root: FolderTreeNode, path: string): FolderTreeNode | null {
  if (root.path === path) return root;
  for (const folder of root.folders) {
    const nested = findFolderNode(folder, path);
    if (nested) return nested;
  }
  return null;
}

export function sameLibrarySelection(
  left: LibrarySelection,
  right: LibrarySelection,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "folder" && right.kind === "folder") {
    return samePath(left.path, right.path);
  }
  return left.kind === "map" && right.kind === "map" && left.mapId === right.mapId;
}

export function sameLibraryDraft(left: LibraryDraft | null, right: LibraryDraft | null): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "new-folder" || left.kind === "new-map") {
    return left.parentPath === (right as Extract<LibraryDraft, { parentPath: string }>).parentPath;
  }
  return sameLibrarySelection(
    left.selection,
    (right as Extract<LibraryDraft, { kind: "rename" }>).selection,
  );
}

export function draftInitialValue(draft: LibraryDraft, payload: MindMapPayload): string {
  if (draft.kind !== "rename") return "";
  if (draft.selection.kind === "folder") return baseName(draft.selection.path);
  const mapId = draft.selection.mapId;
  return baseName(payload.maps.find((map) => map.id === mapId)?.path ?? "");
}

function sortFolder(folder: MutableFolder): void {
  const compare = (left: { readonly name: string }, right: { readonly name: string }): number =>
    compareDisplayNames(left.name, right.name);
  folder.folders.sort(compare);
  folder.maps.sort(compare);
  for (const child of folder.folders) sortFolder(child);
}

function comparePath(left: string, right: string): number {
  return pathDepth(left) - pathDepth(right) || compareLogicalPaths(left, right);
}
