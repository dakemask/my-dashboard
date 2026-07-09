import {
  addArrow as addArrowToData,
  addNode as addNodeToData,
  createEmptyMindMapData,
  createMindMapArrow,
  createMindMapNode,
  deleteArrow as deleteArrowFromData,
  deleteNode as deleteNodeFromData,
  findNode,
  updateNodeFrame,
  updateNodeText,
} from "./mindMap";
import { MindMapView } from "./domSvgMapView";
import {
  clearPrivateDataSettings,
  hasCompletePrivateDataSettings,
  loadPrivateDataSettings,
  savePrivateDataSettings,
} from "../shared/privateData/settings";
import type { PrivateDataSettings } from "../shared/privateData/types";
import {
  deleteMindMapManagedFile,
  loadMindMapLibrary,
  loadMindMapManagedFiles,
  loadMindMapUnknownFiles,
  saveMindMapFolderPlaceholder,
} from "./mindMapLibraryRepository";
import {
  DEFAULT_MIND_MAP_LIBRARY_ROOT,
  findLibraryEntry,
  getBaseName,
  getFolderNameValidation,
  getMapFileNameValidation,
  getMapTitleFromPath,
  getParentPath,
  getRelativeFolderPathValidation,
  isPathEqualOrInside,
  joinPath,
  normalizeMindMapLibraryRoot,
  normalizePath,
  pathExists,
} from "./mindMapLibrary";
import { loadMindMapLocalSnapshot, saveMindMapLocalSnapshot } from "./mindMapLocalStore";
import { loadMindMapDataAtPath, saveMindMapDataAtPath } from "./mindMapRepository";
import {
  addWorkspaceFolder,
  addWorkspaceMap,
  cacheWorkspaceMapData,
  collectWorkspaceMaps,
  createEmptyMindMapWorkspace,
  createMindMapWorkspaceFromRemote,
  createMindMapWorkspaceFromSnapshot,
  createMindMapWorkspaceSnapshot,
  getWorkspaceDesiredFiles,
  getWorkspaceEntry,
  getWorkspaceMapData,
  hasWorkspaceChanges,
  markWorkspaceSaved,
  moveWorkspaceEntry,
  removeWorkspaceEntry,
  updateWorkspaceMapData,
} from "./mindMapWorkspace";
import type {
  MindMapEndpoint,
  MindMapLibraryEntry,
  MindMapLibrarySelection,
  MindMapSelection,
  MindMapState,
  NodeFrame,
} from "./types";
import {
  fillSettingsForm,
  getMindMapElements,
  hideContextMenu,
  readSettingsForm,
  renderLibraryTree,
  setCurrentMapTitle,
  setConnectMode,
  setLibraryActionState,
  setLibraryRootLabel,
  setMapToolsEnabled,
  setStatus,
  showContextMenu,
} from "./view";
import "./style.css";

const DEFAULT_MIND_MAP_DATA_SETTINGS: Partial<PrivateDataSettings> = {
  path: DEFAULT_MIND_MAP_LIBRARY_ROOT,
};
const SETTINGS_STORAGE_OPTIONS = {
  pathStorageKey: "private_data_mind_map_path",
};
const REMOTE_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;

const elements = getMindMapElements();
const mapView = new MindMapView(elements.mapHost, {
  onSelectionChange: setSelection,
  onNodeFrameChange: changeNodeFrame,
  onNodeTextChange: changeNodeText,
  onArrowCreate: createArrow,
  onContextMenu: openContextMenu,
});

let state: MindMapState = {
  selection: null,
  currentMapPath: null,
  data: createEmptyMindMapData(),
};
let workspace = createEmptyMindMapWorkspace();
let librarySelection: MindMapLibrarySelection = null;
let lastOperationAt = Date.now();
let connectMode = false;
let undoStack: MindMapState["data"][] = [];
let redoStack: MindMapState["data"][] = [];

function loadSettings(): PrivateDataSettings {
  const settings = loadPrivateDataSettings(DEFAULT_MIND_MAP_DATA_SETTINGS, SETTINGS_STORAGE_OPTIONS);

  return {
    ...settings,
    path: normalizeMindMapLibraryRoot(settings.path),
  };
}

function requireSettings(): PrivateDataSettings | null {
  const settings = loadSettings();

  if (!hasCompletePrivateDataSettings(settings)) {
    setStatus(elements, "未配置导图库同步。请先点设置填写 GitHub 信息。");
    return null;
  }

  return settings;
}

function render(): void {
  mapView.render(state.data, state.selection);
  setCurrentMapTitle(
    elements,
    state.currentMapPath ? getMapTitleFromPath(state.currentMapPath) : "未打开导图",
    isCurrentMapDirty(),
  );
  setMapToolsEnabled(elements, Boolean(state.currentMapPath), hasUnsavedLocalChanges());
}

function renderLibrary(): void {
  const settings = loadSettings();
  const settingsReady = hasCompletePrivateDataSettings(settings);

  setLibraryRootLabel(elements, hasUnsavedLocalChanges() ? `${settings.path} *` : settings.path);
  renderLibraryTree(
    elements,
    workspace.tree,
    librarySelection?.path ?? null,
    state.currentMapPath,
    workspace.dirtyContentPaths,
    workspace.treeChangePaths,
  );
  setLibraryActionState(elements, settingsReady, librarySelection);
}

async function refreshLibrary(message?: string): Promise<void> {
  const settings = requireSettings();

  if (!settings) {
    workspace = createEmptyMindMapWorkspace();
    librarySelection = null;
    clearCurrentMap();
    renderLibrary();
    return;
  }

  if (hasUnsavedLocalChanges()) {
    const ok = confirm("从 GitHub 刷新会覆盖当前浏览器里的未保存修改。继续吗？");

    if (!ok) {
      return;
    }
  }

  await refreshLocalFromGitHub(settings, message);
}

async function refreshLocalFromGitHub(settings: PrivateDataSettings, message?: string): Promise<void> {
  setStatus(elements, "正在从 GitHub 刷新本地缓存...");
  const [remoteEntries, managedFiles, unknownFilePaths] = await Promise.all([
    loadMindMapLibrary(settings, settings.path),
    loadMindMapManagedFiles(settings, settings.path),
    loadMindMapUnknownFiles(settings, settings.path),
  ]);
  const mapEntries = collectWorkspaceMaps(remoteEntries);
  const nextMaps: Record<string, MindMapState["data"]> = {};
  const remoteShaByPath = new Map(managedFiles.map((file) => [file.path, file.sha]));
  const now = Date.now();

  for (const entry of mapEntries) {
    const result = await loadMindMapDataAtPath(settings, entry.path);

    nextMaps[entry.path] = result.data;
    if (result.sha) {
      remoteShaByPath.set(entry.path, result.sha);
    }
  }

  workspace = createMindMapWorkspaceFromRemote(remoteEntries, nextMaps, remoteShaByPath, unknownFilePaths, now);
  lastOperationAt = now;
  syncCurrentMapAfterLocalRefresh();
  await saveLocalSnapshot();

  render();
  renderLibrary();
  setStatus(elements, message ?? (workspace.tree.length === 0 ? "导图库为空。可以新建导图。" : `已刷新本地缓存：${new Date().toLocaleString()}`));
}

async function refreshMindMap(): Promise<void> {
  mapView.commitActiveEdit();

  if (!state.currentMapPath) {
    setStatus(elements, "请选择或新建导图。");
    return;
  }

  const data = getWorkspaceMapData(workspace, state.currentMapPath);

  if (!data) {
    setStatus(elements, "本地缓存里没有这个导图。请刷新导图库。");
    return;
  }

  state = {
    data,
    selection: null,
    currentMapPath: state.currentMapPath,
  };
  undoStack = [];
  redoStack = [];
  render();
  renderLibrary();
  setStatus(elements, `已从本地缓存重载：${new Date().toLocaleString()}`);
}

async function openMindMap(
  path: string,
  options: { skipDirtyCheck?: boolean; statusMessage?: string } = {},
): Promise<void> {
  mapView.commitActiveEdit();

  if (!options.skipDirtyCheck && !(await ensureFreshBeforeOperation())) {
    return;
  }

  if (!options.skipDirtyCheck) {
    await cacheCurrentMapBeforeSwitch();
  }

  setStatus(elements, "正在打开导图...");

  const normalizedPath = normalizePath(path);
  const data = getWorkspaceMapData(workspace, normalizedPath);

  if (!data) {
    setStatus(elements, "本地缓存里没有这个导图。请刷新导图库。");
    render();
    return;
  }

  state = {
    data,
    selection: null,
    currentMapPath: normalizedPath,
  };
  librarySelection = {
    kind: "map",
    path: normalizedPath,
  };
  undoStack = [];
  redoStack = [];
  setConnectModeEnabled(false);

  render();
  renderLibrary();
  setStatus(elements, options.statusMessage ?? `已打开：${getMapTitleFromPath(normalizedPath)}`);
}

async function persistMindMap(): Promise<void> {
  mapView.commitActiveEdit();

  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  const settings = requireSettings();

  if (!settings) {
    return;
  }

  cacheCurrentMap();

  if (!hasUnsavedLocalChanges()) {
    setStatus(elements, "没有需要保存的修改。");
    return;
  }

  setStatus(elements, "正在保存到 GitHub...");
  const nextRemoteShaByPath = new Map(workspace.remoteShaByPath);
  const desiredPaths = new Set<string>();
  const desiredFiles = getWorkspaceDesiredFiles(workspace);

  for (const file of desiredFiles) {
    desiredPaths.add(file.path);

    if (file.kind === "placeholder") {
      if (workspace.remoteShaByPath.has(file.path)) {
        continue;
      }

      const sha = await saveMindMapFolderPlaceholder(settings, file.folderPath, null);

      nextRemoteShaByPath.set(file.path, sha);
      continue;
    }

    if (!workspace.dirtyContentPaths.has(file.path) && workspace.remoteShaByPath.has(file.path)) {
      continue;
    }

    const sha = await saveMindMapDataAtPath(
      settings,
      file.path,
      file.data,
      workspace.remoteShaByPath.get(file.path) ?? null,
      `save mind map ${file.path}`,
    );

    nextRemoteShaByPath.set(file.path, sha);
  }

  for (const [path, sha] of workspace.remoteShaByPath) {
    if (!desiredPaths.has(path)) {
      await deleteMindMapManagedFile(settings, path, sha);
      nextRemoteShaByPath.delete(path);
    }
  }

  lastOperationAt = Date.now();
  markWorkspaceSaved(workspace, nextRemoteShaByPath, lastOperationAt);
  syncCurrentMapAfterLocalRefresh();
  await saveLocalSnapshot();
  render();
  renderLibrary();
  setStatus(elements, `已保存到 GitHub：${new Date().toLocaleString()}`);
}

async function cacheCurrentMapBeforeSwitch(): Promise<void> {
  if (!state.currentMapPath) {
    return;
  }

  cacheCurrentMap();
  await saveLocalSnapshot();
}

function clearCurrentMap(): void {
  state = {
    data: createEmptyMindMapData(),
    selection: null,
    currentMapPath: null,
  };
  undoStack = [];
  redoStack = [];
  setConnectModeEnabled(false);
  render();
}

function readNormalizedSettingsForm(): PrivateDataSettings {
  const settings = readSettingsForm(elements);

  return {
    ...settings,
    path: normalizeMindMapLibraryRoot(settings.path),
  };
}

function hasUnsavedLocalChanges(): boolean {
  return hasWorkspaceChanges(workspace);
}

async function loadLocalSnapshot(): Promise<boolean> {
  const settings = loadSettings();

  if (!hasCompletePrivateDataSettings(settings)) {
    return false;
  }

  const snapshot = await loadMindMapLocalSnapshot(settings);

  if (!snapshot) {
    return false;
  }

  workspace = createMindMapWorkspaceFromSnapshot(snapshot);
  syncCurrentMapAfterLocalRefresh();
  render();
  renderLibrary();
  return true;
}

async function saveLocalSnapshot(): Promise<void> {
  const settings = loadSettings();

  if (!hasCompletePrivateDataSettings(settings)) {
    return;
  }

  await saveMindMapLocalSnapshot(settings, {
    rootPath: settings.path,
    ...createMindMapWorkspaceSnapshot(workspace),
    updatedAt: Date.now(),
  });
}

function cacheCurrentMap(): void {
  if (!state.currentMapPath) {
    return;
  }

  cacheWorkspaceMapData(workspace, state.currentMapPath, state.data);
}

function syncCurrentMapAfterLocalRefresh(): void {
  if (!state.currentMapPath) {
    return;
  }

  const data = getWorkspaceMapData(workspace, state.currentMapPath);

  if (!data || !pathExists(workspace.tree, state.currentMapPath)) {
    clearCurrentMap();
    return;
  }

  state = {
    data,
    selection: null,
    currentMapPath: state.currentMapPath,
  };
  undoStack = [];
  redoStack = [];
}

function isRemoteRefreshDue(): boolean {
  return Date.now() - lastOperationAt > REMOTE_REFRESH_INTERVAL_MS;
}

async function ensureFreshBeforeOperation(): Promise<boolean> {
  if (!isRemoteRefreshDue()) {
    lastOperationAt = Date.now();
    return true;
  }

  const settings = requireSettings();

  if (!settings) {
    lastOperationAt = Date.now();
    return true;
  }

  if (hasUnsavedLocalChanges()) {
    const ok = confirm("距离上次操作已经超过 2 小时。是否先从 GitHub 刷新并覆盖浏览器本地缓存？确定会丢弃当前未保存修改。");

    if (!ok) {
      lastOperationAt = Date.now();
      return true;
    }
  }

  try {
    await refreshLocalFromGitHub(settings, "已因空闲超过 2 小时，从 GitHub 刷新本地缓存。");
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }

  lastOperationAt = Date.now();
  return true;
}

function markLibraryChanged(message: string): void {
  lastOperationAt = Date.now();
  setStatus(elements, message);
  render();
  renderLibrary();
  void saveLocalSnapshot().catch((error) => {
    setStatus(elements, getErrorMessage(error));
  });
}

function isCurrentMapDirty(): boolean {
  return Boolean(
    state.currentMapPath &&
      (workspace.dirtyContentPaths.has(state.currentMapPath) || workspace.treeChangePaths.has(state.currentMapPath)),
  );
}

function getSelectedDirectoryPath(rootPath: string): string {
  if (!librarySelection) {
    return rootPath;
  }

  if (librarySelection.kind === "folder") {
    return librarySelection.path;
  }

  return getParentPath(librarySelection.path) || rootPath;
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

function getExistingTargetFolderPath(settings: PrivateDataSettings, initialPath: string): string | null {
  const input = prompt("输入目标文件夹路径（相对于导图库根目录，留空表示根目录）", initialPath);

  if (input === null) {
    return null;
  }

  const validation = getRelativeFolderPathValidation(input);

  if (validation.error) {
    setStatus(elements, validation.error);
    return null;
  }

  const targetPath = validation.value ? joinPath(settings.path, validation.value) : settings.path;
  const entry = findLibraryEntry(workspace.tree, targetPath);

  if (targetPath !== settings.path && entry?.kind !== "folder") {
    setStatus(elements, "目标文件夹不存在。");
    return null;
  }

  return targetPath;
}

function ensureAvailablePath(path: string): boolean {
  if (!pathExists(workspace.tree, path)) {
    return true;
  }

  setStatus(elements, "同名文件或文件夹已存在。");
  return false;
}

function ensureFolderHasNoRemoteUnknownFiles(folderPath: string): boolean {
  const unknownPath = [...workspace.remoteUnknownFilePaths].find((path) => isPathEqualOrInside(path, folderPath));

  if (!unknownPath) {
    return true;
  }

  setStatus(elements, `文件夹中包含非导图库管理文件，已阻止操作：${unknownPath}`);
  return false;
}

function syncMovedCurrentMap(fromPath: string, toPath: string): void {
  if (!state.currentMapPath || !isPathEqualOrInside(state.currentMapPath, fromPath)) {
    return;
  }

  const currentPath = state.currentMapPath;
  const nextPath = normalizePath(currentPath === fromPath ? toPath : joinPath(toPath, currentPath.slice(fromPath.length + 1)));

  state.currentMapPath = nextPath;
  render();
}

function moveLocalLibraryEntry(entry: MindMapLibraryEntry, nextPath: string, rootPath: string): void {
  moveWorkspaceEntry(workspace, entry, nextPath, rootPath);
  syncMovedCurrentMap(entry.path, nextPath);
  librarySelection = {
    kind: entry.kind,
    path: nextPath,
  };
  render();
  renderLibrary();
}

function removeLocalLibraryEntry(entry: MindMapLibraryEntry): void {
  removeWorkspaceEntry(workspace, entry);

  if (entry.kind === "map" && state.currentMapPath === entry.path) {
    clearCurrentMap();
  } else if (entry.kind === "folder" && state.currentMapPath && isPathEqualOrInside(state.currentMapPath, entry.path)) {
    clearCurrentMap();
  } else {
    render();
  }

  librarySelection = null;
  renderLibrary();
}

async function createFolder(): Promise<void> {
  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  const settings = requireSettings();

  if (!settings) {
    return;
  }

  const input = prompt("新文件夹名称");

  if (input === null) {
    return;
  }

  const validation = getFolderNameValidation(input);

  if (validation.error) {
    setStatus(elements, validation.error);
    return;
  }

  const folderPath = joinPath(getSelectedDirectoryPath(settings.path), validation.value);

  if (!ensureAvailablePath(folderPath)) {
    return;
  }

  addWorkspaceFolder(workspace, settings.path, folderPath);
  librarySelection = {
    kind: "folder",
    path: folderPath,
  };
  markLibraryChanged("已在本地新建文件夹，尚未保存到 GitHub。");
}

async function createMap(): Promise<void> {
  mapView.commitActiveEdit();

  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  const settings = requireSettings();

  if (!settings) {
    return;
  }

  await cacheCurrentMapBeforeSwitch();

  const input = prompt("新导图名称");

  if (input === null) {
    return;
  }

  const validation = getMapFileNameValidation(input);

  if (validation.error) {
    setStatus(elements, validation.error);
    return;
  }

  const filePath = joinPath(getSelectedDirectoryPath(settings.path), validation.value);

  if (!ensureAvailablePath(filePath)) {
    return;
  }

  state = {
    data: createEmptyMindMapData(),
    selection: null,
    currentMapPath: filePath,
  };
  addWorkspaceMap(workspace, settings.path, filePath, state.data);
  undoStack = [];
  redoStack = [];
  librarySelection = {
    kind: "map",
    path: filePath,
  };
  setConnectModeEnabled(false);
  markLibraryChanged(`已在本地新建导图：${getMapTitleFromPath(filePath)}，尚未保存到 GitHub。`);
}

async function renameLibraryEntry(): Promise<void> {
  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  const settings = requireSettings();
  const selection = librarySelection;

  if (!settings || !selection) {
    return;
  }

  const entry = getWorkspaceEntry(workspace, selection.path);

  if (!entry) {
    setStatus(elements, "请选择要重命名的导图或文件夹。");
    return;
  }

  if (entry.kind === "folder" && !ensureFolderHasNoRemoteUnknownFiles(entry.path)) {
    return;
  }

  const input = prompt("新名称", entry.kind === "map" ? getMapTitleFromPath(entry.path) : entry.name);

  if (input === null) {
    return;
  }

  if (entry.kind === "map") {
    const validation = getMapFileNameValidation(input);

    if (validation.error) {
      setStatus(elements, validation.error);
      return;
    }

    const nextPath = joinPath(getParentPath(entry.path), validation.value);

    if (nextPath === entry.path) {
      return;
    }

    if (!ensureAvailablePath(nextPath)) {
      return;
    }

    moveLocalLibraryEntry(entry, nextPath, settings.path);
    markLibraryChanged("已在本地重命名导图，尚未保存到 GitHub。");
    return;
  }

  const validation = getFolderNameValidation(input);

  if (validation.error) {
    setStatus(elements, validation.error);
    return;
  }

  const nextPath = joinPath(getParentPath(entry.path), validation.value);

  if (nextPath === entry.path) {
    return;
  }

  if (!ensureAvailablePath(nextPath)) {
    return;
  }

  moveLocalLibraryEntry(entry, nextPath, settings.path);
  markLibraryChanged("已在本地重命名文件夹，尚未保存到 GitHub。");
}

async function moveLibraryEntry(): Promise<void> {
  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  const settings = requireSettings();
  const selection = librarySelection;

  if (!settings || !selection) {
    return;
  }

  const entry = getWorkspaceEntry(workspace, selection.path);

  if (!entry) {
    setStatus(elements, "请选择要移动的导图或文件夹。");
    return;
  }

  if (entry.kind === "folder" && !ensureFolderHasNoRemoteUnknownFiles(entry.path)) {
    return;
  }

  const targetFolderPath = getExistingTargetFolderPath(settings, getRelativePath(getParentPath(entry.path), settings.path));

  if (targetFolderPath === null) {
    return;
  }

  if (entry.kind === "folder" && isPathEqualOrInside(targetFolderPath, entry.path)) {
    setStatus(elements, "文件夹不能移动到自己或自己的子文件夹。");
    return;
  }

  const nextPath = joinPath(targetFolderPath, getBaseName(entry.path));

  if (nextPath === entry.path) {
    setStatus(elements, "位置没有变化。");
    return;
  }

  if (!ensureAvailablePath(nextPath)) {
    return;
  }

  moveLocalLibraryEntry(entry, nextPath, settings.path);
  markLibraryChanged(entry.kind === "map" ? "已在本地移动导图，尚未保存到 GitHub。" : "已在本地移动文件夹，尚未保存到 GitHub。");
}

async function deleteLibraryEntry(): Promise<void> {
  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  const settings = requireSettings();
  const selection = librarySelection;

  if (!settings || !selection) {
    return;
  }

  const entry = getWorkspaceEntry(workspace, selection.path);

  if (!entry) {
    setStatus(elements, "请选择要删除的导图或文件夹。");
    return;
  }

  if (entry.kind === "folder" && !ensureFolderHasNoRemoteUnknownFiles(entry.path)) {
    return;
  }

  const label = entry.kind === "map" ? `导图“${getMapTitleFromPath(entry.path)}”` : `文件夹“${entry.name}”及其中所有导图`;
  const ok = confirm(`确定删除${label}吗？此操作会删除 GitHub 仓库中的对应文件。`);

  if (!ok) {
    return;
  }

  removeLocalLibraryEntry(entry);
  markLibraryChanged("已在本地删除，尚未保存到 GitHub。");
}

async function addNode(): Promise<void> {
  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  if (!state.currentMapPath) {
    setStatus(elements, "请先选择或新建导图。");
    return;
  }

  const position = mapView.getNewNodePosition();
  const node = createMindMapNode(position.x, position.y);
  commitChange(
    addNodeToData(state.data, node),
    {
      type: "node",
      id: node.id,
    },
    "已新增框，尚未保存。",
  );
  requestAnimationFrame(() => mapView.editNodeText(node.id));
}

function changeNodeFrame(id: string, frame: NodeFrame): void {
  const node = findNode(state.data, id);

  if (!node) {
    return;
  }

  if (isSameFrame(node, frame)) {
    return;
  }

  commitChange(
    updateNodeFrame(state.data, id, frame),
    {
      type: "node",
      id,
    },
    "已调整框，尚未保存。",
  );
}

function changeNodeText(id: string, text: string, frame?: NodeFrame): void {
  const node = findNode(state.data, id);

  if (!node) {
    return;
  }

  if (node.text === text && (!frame || isSameFrame(node, frame))) {
    return;
  }

  commitChange(
    updateNodeText(state.data, id, text, frame),
    {
      type: "node",
      id,
    },
    "已编辑文字，尚未保存。",
  );
}

function createArrow(from: MindMapEndpoint, to: MindMapEndpoint): void {
  const next = addArrowToData(state.data, createMindMapArrow(from, to));

  if (next === state.data) {
    return;
  }

  setConnectModeEnabled(false);
  commitChange(
    next,
    {
      type: "arrow",
      id: next.arrows[next.arrows.length - 1].id,
    },
    "已新增箭头，尚未保存。",
  );
}

function deleteSelection(): void {
  if (!state.selection) {
    return;
  }

  if (state.selection.type === "node") {
    commitChange(deleteNodeFromData(state.data, state.selection.id), null, "已删除框，尚未保存。");
  } else {
    commitChange(deleteArrowFromData(state.data, state.selection.id), null, "已删除箭头，尚未保存。");
  }

  hideContextMenu(elements);
}

function setSelection(selection: MindMapSelection): void {
  if (isSameSelection(state.selection, selection)) {
    hideContextMenu(elements);
    return;
  }

  state.selection = selection;
  hideContextMenu(elements);
  render();
}

function openContextMenu(selection: MindMapSelection, x: number, y: number): void {
  state.selection = selection;
  render();

  if (selection) {
    showContextMenu(elements, x, y);
  }
}

function markDirty(message: string): void {
  if (state.currentMapPath) {
    updateWorkspaceMapData(workspace, state.currentMapPath, state.data);
  }
  lastOperationAt = Date.now();
  setStatus(elements, message);
  void saveLocalSnapshot().catch((error) => {
    setStatus(elements, getErrorMessage(error));
  });
}

function commitChange(data: MindMapState["data"], selection: MindMapSelection, message: string): void {
  undoStack.push(state.data);
  redoStack = [];
  state.data = data;
  state.selection = selection;
  markDirty(message);
  render();
  renderLibrary();
}

function undo(): void {
  const previous = undoStack.pop();

  if (!previous) {
    return;
  }

  redoStack.push(state.data);
  state.data = previous;
  state.selection = null;
  markDirty("已撤销，尚未保存。");
  render();
  renderLibrary();
}

function redo(): void {
  const next = redoStack.pop();

  if (!next) {
    return;
  }

  undoStack.push(state.data);
  state.data = next;
  state.selection = null;
  markDirty("已重做，尚未保存。");
  render();
  renderLibrary();
}

function setConnectModeEnabled(enabled: boolean): void {
  connectMode = enabled;
  setConnectMode(elements, connectMode);
  mapView.setConnectMode(connectMode);
}

function isSameSelection(current: MindMapSelection, next: MindMapSelection): boolean {
  return current?.type === next?.type && current?.id === next?.id;
}

function isSameFrame(current: NodeFrame, next: NodeFrame): boolean {
  return (
    current.x === next.x &&
    current.y === next.y &&
    current.width === next.width &&
    current.height === next.height &&
    (next.autoWidth === undefined || current.autoWidth === next.autoWidth)
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFormEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function isMindMapTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(".mind-map-node-text"));
}

function isLibraryControlTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest(".library-panel"));
}

function isMapInteractionTarget(target: EventTarget | null): boolean {
  return target instanceof Node && elements.mapHost.contains(target);
}

elements.settingsBtn.addEventListener("click", () => {
  elements.settingsPanel.classList.toggle("hidden");
});

elements.saveSettingsBtn.addEventListener("click", async () => {
  savePrivateDataSettings(readNormalizedSettingsForm(), SETTINGS_STORAGE_OPTIONS);
  fillSettingsForm(elements, loadSettings());

  if (hasUnsavedLocalChanges()) {
    setStatus(elements, "设置已保存。浏览器本地仍有未保存修改，请保存后再从 GitHub 刷新。");
    renderLibrary();
    return;
  }

  try {
    clearCurrentMap();
    workspace = createEmptyMindMapWorkspace();
    librarySelection = null;
    const settings = requireSettings();

    if (settings) {
      await refreshLocalFromGitHub(settings);
    }
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.clearSettingsBtn.addEventListener("click", () => {
  clearPrivateDataSettings(SETTINGS_STORAGE_OPTIONS);
  fillSettingsForm(elements, loadSettings());
  workspace = createEmptyMindMapWorkspace();
  librarySelection = null;
  renderLibrary();
  setStatus(elements, "已清除当前浏览器里的设置。");
});

elements.addNodeBtn.addEventListener("click", () => {
  void addNode().catch((error) => {
    setStatus(elements, getErrorMessage(error));
  });
});

elements.refreshLibraryBtn.addEventListener("click", async () => {
  try {
    await refreshLibrary();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.newFolderBtn.addEventListener("click", async () => {
  try {
    await createFolder();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.newMapBtn.addEventListener("click", async () => {
  try {
    await createMap();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.renameEntryBtn.addEventListener("click", async () => {
  try {
    await renameLibraryEntry();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.moveEntryBtn.addEventListener("click", async () => {
  try {
    await moveLibraryEntry();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.deleteEntryBtn.addEventListener("click", async () => {
  try {
    await deleteLibraryEntry();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.libraryTree.addEventListener("click", (event) => {
  const entryButton = (event.target as Element | null)?.closest<HTMLButtonElement>(".library-entry");

  if (!entryButton?.dataset.libraryPath || !entryButton.dataset.libraryKind) {
    return;
  }

  const path = entryButton.dataset.libraryPath;
  const kind = entryButton.dataset.libraryKind === "folder" ? "folder" : "map";

  librarySelection = {
    kind,
    path,
  };
  renderLibrary();

  if (kind === "map" && path !== state.currentMapPath) {
    void openMindMap(path).catch((error) => {
      setStatus(elements, getErrorMessage(error));
    });
  }
});

elements.connectBtn.addEventListener("click", () => {
  void ensureFreshBeforeOperation()
    .then(() => {
      setConnectModeEnabled(!connectMode);
    })
    .catch((error) => {
      setStatus(elements, getErrorMessage(error));
    });
});

elements.saveBtn.addEventListener("click", async () => {
  try {
    await persistMindMap();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.refreshBtn.addEventListener("click", async () => {
  try {
    await refreshMindMap();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.resetBtn.addEventListener("click", () => {
  mapView.resetView();
});

elements.contextDeleteBtn.addEventListener("click", deleteSelection);

document.addEventListener(
  "pointerdown",
  (event) => {
    if (!isMapInteractionTarget(event.target) || !isRemoteRefreshDue()) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void ensureFreshBeforeOperation().then(() => {
      setStatus(elements, "已完成空闲检查，请重试刚才的画布操作。");
    });
  },
  true,
);

document.addEventListener("click", (event) => {
  if (!elements.contextMenu.contains(event.target as Node)) {
    hideContextMenu(elements);
  }
});

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  const commandKey = event.ctrlKey || event.metaKey;

  if (commandKey && key === "s") {
    event.preventDefault();
    mapView.commitActiveEdit();
    void persistMindMap().catch((error) => {
      setStatus(elements, getErrorMessage(error));
    });
    return;
  }

  if (isFormEditableTarget(event.target)) {
    return;
  }

  if (isMindMapTextTarget(event.target)) {
    return;
  }

  if (isLibraryControlTarget(event.target)) {
    return;
  }

  if (commandKey && key === "z") {
    event.preventDefault();
    if (event.shiftKey) {
      redo();
    } else {
      undo();
    }
    return;
  }

  if (commandKey && key === "y") {
    event.preventDefault();
    redo();
    return;
  }

  if (event.altKey && !commandKey && key === "1") {
    event.preventDefault();
    void addNode().catch((error) => {
      setStatus(elements, getErrorMessage(error));
    });
    return;
  }

  if (event.altKey && !commandKey && key === "2") {
    event.preventDefault();
    if (!state.currentMapPath) {
      setStatus(elements, "请先选择或新建导图。");
      return;
    }
    void ensureFreshBeforeOperation()
      .then(() => {
        setConnectModeEnabled(true);
      })
      .catch((error) => {
        setStatus(elements, getErrorMessage(error));
      });
    return;
  }

  if (event.key === "Enter" && state.selection?.type === "node") {
    event.preventDefault();
    mapView.editNodeText(state.selection.id);
    return;
  }

  if (event.key !== "Delete" && event.key !== "Backspace") {
    return;
  }

  if (state.selection) {
    event.preventDefault();
    deleteSelection();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!hasUnsavedLocalChanges()) {
    return;
  }

  event.preventDefault();
});

fillSettingsForm(elements, loadSettings());
setConnectModeEnabled(connectMode);
render();
renderLibrary();
void initializeMindMap().catch((error) => {
  setStatus(elements, getErrorMessage(error));
});

async function initializeMindMap(): Promise<void> {
  const hadLocalSnapshot = await loadLocalSnapshot();
  const settings = requireSettings();

  if (!settings) {
    if (!hadLocalSnapshot) {
      render();
      renderLibrary();
    }
    return;
  }

  try {
    await refreshLocalFromGitHub(settings, "已从 GitHub 同步到浏览器本地缓存。");
  } catch (error) {
    setStatus(elements, hadLocalSnapshot ? `GitHub 刷新失败，正在使用本地缓存：${getErrorMessage(error)}` : getErrorMessage(error));
  }
}
