import {
  baseName,
  comparableLibraryName,
  isMapPathInsideFolder,
  isSameOrDescendantPath,
  joinPath,
  normalizeFolderName,
  normalizeMapName,
  parentPath,
  samePath,
  type MindMapDocument,
  type MindMapEvent,
  type MindMapPayload,
} from "../domain";
import type {
  LibraryDraft,
  LibrarySelection,
  SettledLibraryDraft,
} from "../library/treeView";

export type LibraryCommandEffect =
  | { readonly type: "select-folder"; readonly path: string; readonly parentPath: string }
  | {
      readonly type: "open-map";
      readonly mapId: string;
      readonly path: string;
      readonly parentPath: string;
    }
  | { readonly type: "remap-folder"; readonly fromPath: string; readonly toPath: string }
  | { readonly type: "select-map"; readonly mapId: string; readonly path: string };

export interface LibraryCommandPlan {
  readonly event: MindMapEvent | null;
  readonly effect: LibraryCommandEffect;
}

export type LibraryMovePlan =
  | { readonly status: "noop" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "ready"; readonly event: MindMapEvent; readonly effect: LibraryCommandEffect };

export interface LibraryDeletePlan {
  readonly event: Extract<MindMapEvent, { readonly type: "delete-folder" | "delete-map" }>;
  readonly closesCurrentMap: boolean;
  readonly fallbackFolderPath: string;
}

export function selectedParentPath(
  payload: MindMapPayload,
  selection: LibrarySelection,
): string {
  if (selection?.kind === "folder") return selection.path;
  if (selection?.kind === "map") return parentPath(findMap(payload, selection.mapId)?.path ?? "");
  return "";
}

export function validateLibraryDraft(
  payload: MindMapPayload,
  draft: LibraryDraft,
  value: string,
): string | null {
  try {
    const kind = draftKind(draft);
    const name = normalizeDraftName(kind, value);
    const parent = draftParent(draft, payload);
    if (kind === "map" && parent === "" && comparableLibraryName(name, "map") === "revision") {
      return "根目录的脑图不能命名为 revision。";
    }
    const excluded = draft.kind === "rename" ? draft.selection : null;
    if (hasSibling(payload, parent, name, kind, excluded)) {
      return kind === "folder" ? "同一层已有同名文件夹。" : "同一层已有同名脑图。";
    }
    return null;
  } catch (error) {
    return error instanceof TypeError ? error.message : "名称无效。";
  }
}

export function planLibraryDraft(
  payload: MindMapPayload,
  settled: SettledLibraryDraft,
  createId: () => string,
): LibraryCommandPlan {
  const { draft, value } = settled;
  const kind = draftKind(draft);
  const name = normalizeDraftName(kind, value);
  if (draft.kind === "new-folder") {
    const path = joinPath(draft.parentPath, name);
    return {
      event: { type: "create-folder", path },
      effect: { type: "select-folder", path, parentPath: draft.parentPath },
    };
  }
  if (draft.kind === "new-map") {
    const id = createId();
    const path = joinPath(draft.parentPath, name);
    const map: MindMapDocument = { id, path, nodes: [], boxes: [], brackets: [], arrows: [] };
    return {
      event: { type: "create-map", map },
      effect: { type: "open-map", mapId: id, path, parentPath: draft.parentPath },
    };
  }
  if (draft.selection.kind === "folder") {
    const fromPath = draft.selection.path;
    const toPath = joinPath(parentPath(fromPath), name);
    return {
      event: toPath === fromPath ? null : { type: "relocate-folder", fromPath, toPath },
      effect: { type: "remap-folder", fromPath, toPath },
    };
  }
  const mapId = draft.selection.mapId;
  const map = findMap(payload, mapId);
  if (!map) throw new TypeError("脑图已不存在。");
  const path = joinPath(parentPath(map.path), name);
  return {
    event: path === map.path ? null : { type: "relocate-map", mapId, path },
    effect: { type: "select-map", mapId, path },
  };
}

export function isLibraryPlanApplied(
  payload: MindMapPayload,
  plan: LibraryCommandPlan,
): boolean {
  switch (plan.effect.type) {
    case "select-folder":
      return payload.folders.includes(plan.effect.path);
    case "open-map": {
      const { mapId, path } = plan.effect;
      return payload.maps.some((map) =>
        map.id === mapId && map.path === path);
    }
    case "select-map": {
      const { mapId, path } = plan.effect;
      return payload.maps.some((map) =>
        map.id === mapId && map.path === path);
    }
    case "remap-folder":
      return payload.folders.includes(plan.effect.toPath);
  }
}

export function planLibraryMove(
  payload: MindMapPayload,
  selection: Exclude<LibrarySelection, null>,
  destination: string,
): LibraryMovePlan {
  if (selection.kind === "folder") {
    const fromPath = selection.path;
    if (destination && isSameOrDescendantPath(destination, fromPath)) {
      return { status: "invalid", message: "文件夹不能移动到自身或其子文件夹中。" };
    }
    const toPath = joinPath(destination, baseName(fromPath));
    if (toPath === fromPath) return { status: "noop" };
    if (hasSibling(payload, destination, baseName(fromPath), "folder", selection)) {
      return { status: "invalid", message: "目标位置已有同名文件夹。" };
    }
    return {
      status: "ready",
      event: { type: "relocate-folder", fromPath, toPath },
      effect: { type: "remap-folder", fromPath, toPath },
    };
  }

  const map = findMap(payload, selection.mapId);
  if (!map) return { status: "noop" };
  const path = joinPath(destination, baseName(map.path));
  if (path === map.path) return { status: "noop" };
  if (hasSibling(payload, destination, baseName(map.path), "map", selection)) {
    return { status: "invalid", message: "目标位置已有同名脑图。" };
  }
  return {
    status: "ready",
    event: { type: "relocate-map", mapId: map.id, path },
    effect: { type: "select-map", mapId: map.id, path },
  };
}

export function planLibraryDelete(
  payload: MindMapPayload,
  selection: Exclude<LibrarySelection, null>,
  currentMapId: string | null,
): LibraryDeletePlan {
  if (selection.kind === "folder") {
    const currentMap = currentMapId ? findMap(payload, currentMapId) : null;
    return {
      event: { type: "delete-folder", path: selection.path },
      closesCurrentMap: Boolean(
        currentMap && isMapPathInsideFolder(currentMap.path, selection.path),
      ),
      fallbackFolderPath: parentPath(selection.path),
    };
  }
  return {
    event: { type: "delete-map", mapId: selection.mapId },
    closesCurrentMap: currentMapId === selection.mapId,
    fallbackFolderPath: "",
  };
}

export function hasPendingLibraryChange(
  payload: MindMapPayload,
  draft: LibraryDraft | null,
  value: string | null,
): boolean {
  if (!draft || value === null || validateLibraryDraft(payload, draft, value) !== null) return false;
  if (draft.kind === "new-folder" || draft.kind === "new-map") return true;
  if (draft.selection.kind === "folder") {
    const selectedPath = draft.selection.path;
    const current = payload.folders.find((path) => path === selectedPath);
    return current !== undefined && normalizeFolderName(value) !== baseName(current);
  }
  const current = findMap(payload, draft.selection.mapId);
  return current !== null && normalizeMapName(value) !== baseName(current.path);
}

export function retainLibrarySelection(
  selection: LibrarySelection,
  payload: MindMapPayload,
): LibrarySelection {
  if (selection?.kind === "folder") {
    return payload.folders.includes(selection.path) ? selection : null;
  }
  if (selection?.kind === "map") {
    return payload.maps.some((map) => map.id === selection.mapId) ? selection : null;
  }
  return null;
}

export function nearestExistingFolder(
  path: string,
  payload: MindMapPayload,
): LibrarySelection {
  let candidate = path;
  while (candidate) {
    if (payload.folders.includes(candidate)) return { kind: "folder", path: candidate };
    candidate = parentPath(candidate);
  }
  return null;
}

function draftKind(draft: LibraryDraft): "folder" | "map" {
  if (draft.kind === "new-folder") return "folder";
  if (draft.kind === "new-map") return "map";
  return draft.selection.kind;
}

function draftParent(draft: LibraryDraft, payload: MindMapPayload): string {
  if (draft.kind === "new-folder" || draft.kind === "new-map") return draft.parentPath;
  if (draft.selection.kind === "folder") return parentPath(draft.selection.path);
  return parentPath(findMap(payload, draft.selection.mapId)?.path ?? "");
}

function normalizeDraftName(kind: "folder" | "map", value: string): string {
  return kind === "folder" ? normalizeFolderName(value) : normalizeMapName(value);
}

function hasSibling(
  payload: MindMapPayload,
  parent: string,
  name: string,
  kind: "folder" | "map",
  excluded: Exclude<LibrarySelection, null> | null,
): boolean {
  const key = comparableLibraryName(name, kind);
  if (kind === "folder") {
    return payload.folders.some((path) =>
      samePath(parentPath(path), parent)
      && !(excluded?.kind === "folder" && excluded.path === path)
      && comparableLibraryName(baseName(path), "folder") === key);
  }
  return payload.maps.some((map) =>
    samePath(parentPath(map.path), parent)
    && !(excluded?.kind === "map" && excluded.mapId === map.id)
    && comparableLibraryName(baseName(map.path), "map") === key);
}

function findMap(payload: MindMapPayload, mapId: string): MindMapDocument | null {
  return payload.maps.find((map) => map.id === mapId) ?? null;
}
