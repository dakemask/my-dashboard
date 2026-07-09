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
  DEFAULT_MIND_MAP_LIBRARY_ROOT,
  getMapTitleFromPath,
  normalizeMindMapLibraryRoot,
  normalizePath,
  pathExists,
} from "./mindMapLibrary";
import {
  createMindMapFileAction,
  createMindMapFolderAction,
  deleteMindMapLibraryEntryAction,
  moveMindMapLibraryEntryAction,
  renameMindMapLibraryEntryAction,
  type MindMapLibraryActionContext,
  type MindMapLibraryActionResult,
} from "./mindMapLibraryActions";
import {
  loadLocalMindMapWorkspace,
  loadRemoteMindMapWorkspace,
  saveLocalMindMapWorkspace,
  saveRemoteMindMapWorkspace,
} from "./mindMapSync";
import {
  cacheWorkspaceMapData,
  createEmptyMindMapWorkspace,
  getWorkspaceMapData,
  hasWorkspaceChanges,
  updateWorkspaceMapData,
} from "./mindMapWorkspace";
import type {
  MindMapEndpoint,
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
  setSaveOverlayVisible,
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
let saveInProgress = false;
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
  renderSyncStatus();
}

function renderSyncStatus(): void {
  setStatus(
    elements,
    workspace.lastRemoteRefreshAt === null
      ? "尚未同步"
      : `最近同步：${new Date(workspace.lastRemoteRefreshAt).toLocaleString()}`,
  );
}

async function refreshLibrary(): Promise<void> {
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

  await refreshLocalFromGitHub(settings);
}

async function refreshLocalFromGitHub(settings: PrivateDataSettings): Promise<void> {
  workspace = await loadRemoteMindMapWorkspace(settings);
  lastOperationAt = workspace.lastRemoteRefreshAt ?? Date.now();
  syncCurrentMapAfterLocalRefresh();
  await saveLocalSnapshot();

  render();
  renderLibrary();
}

async function refreshMindMap(): Promise<void> {
  mapView.commitActiveEdit();

  if (!state.currentMapPath) {
    return;
  }

  const data = getWorkspaceMapData(workspace, state.currentMapPath);

  if (!data) {
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
}

async function openMindMap(
  path: string,
  options: { skipDirtyCheck?: boolean } = {},
): Promise<void> {
  mapView.commitActiveEdit();

  if (!options.skipDirtyCheck && !(await ensureFreshBeforeOperation())) {
    return;
  }

  if (!options.skipDirtyCheck) {
    await cacheCurrentMapBeforeSwitch();
  }

  const normalizedPath = normalizePath(path);
  const data = getWorkspaceMapData(workspace, normalizedPath);

  if (!data) {
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
}

async function persistMindMap(): Promise<void> {
  if (saveInProgress) {
    return;
  }

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
    return;
  }

  saveInProgress = true;
  setSaveOverlayVisible(elements, true);

  try {
    lastOperationAt = await saveRemoteMindMapWorkspace(settings, workspace);
    syncCurrentMapAfterLocalRefresh();
    await saveLocalSnapshot();
    render();
    renderLibrary();
  } finally {
    saveInProgress = false;
    setSaveOverlayVisible(elements, false);
  }
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

  const localWorkspace = await loadLocalMindMapWorkspace(settings);

  if (!localWorkspace) {
    return false;
  }

  workspace = localWorkspace;
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

  await saveLocalMindMapWorkspace(settings, workspace);
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
    await refreshLocalFromGitHub(settings);
  } catch (error) {
    console.error(error);
  }

  lastOperationAt = Date.now();
  return true;
}

function markLibraryChanged(): void {
  lastOperationAt = Date.now();
  render();
  renderLibrary();
  void saveLocalSnapshot().catch((error) => {
    console.error(error);
  });
}

function isCurrentMapDirty(): boolean {
  return Boolean(
    state.currentMapPath &&
      (workspace.dirtyContentPaths.has(state.currentMapPath) || workspace.treeChangePaths.has(state.currentMapPath)),
  );
}

async function createFolder(): Promise<void> {
  await runLibraryAction(createMindMapFolderAction);
}

async function createMap(): Promise<void> {
  mapView.commitActiveEdit();
  await cacheCurrentMapBeforeSwitch();
  await runLibraryAction(createMindMapFileAction);
}

async function renameLibraryEntry(): Promise<void> {
  mapView.commitActiveEdit();
  cacheCurrentMap();
  await runLibraryAction(renameMindMapLibraryEntryAction);
}

async function moveLibraryEntry(): Promise<void> {
  mapView.commitActiveEdit();
  cacheCurrentMap();
  await runLibraryAction(moveMindMapLibraryEntryAction);
}

async function deleteLibraryEntry(): Promise<void> {
  mapView.commitActiveEdit();
  cacheCurrentMap();
  await runLibraryAction(deleteMindMapLibraryEntryAction);
}

async function runLibraryAction(
  action: (context: MindMapLibraryActionContext) => MindMapLibraryActionResult,
): Promise<void> {
  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  const settings = requireSettings();

  if (!settings) {
    return;
  }

  const result = action({
    currentMapPath: state.currentMapPath,
    rootPath: settings.path,
    selection: librarySelection,
    workspace,
  });

  if (!result.changed) {
    return;
  }

  librarySelection = result.selection;

  if (result.openedMap) {
    state = {
      data: result.openedMap.data,
      selection: null,
      currentMapPath: result.openedMap.path,
    };
    undoStack = [];
    redoStack = [];
    setConnectModeEnabled(false);
  } else if (result.currentMapPath === null) {
    clearCurrentMap();
  } else if (result.currentMapPath !== undefined) {
    state.currentMapPath = result.currentMapPath;
  }

  markLibraryChanged();
}

async function addNode(): Promise<void> {
  if (!(await ensureFreshBeforeOperation())) {
    return;
  }

  if (!state.currentMapPath) {
    return;
  }

  const position = mapView.getNewNodePosition();
  const node = createMindMapNode(position.x, position.y);
  commitChange(
    addNodeToData(state.data, node),
    {
      type: "node",
      id: node.id,
    }
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
    }
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
    }
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
    }
  );
}

function deleteSelection(): void {
  if (!state.selection) {
    return;
  }

  if (state.selection.type === "node") {
    commitChange(deleteNodeFromData(state.data, state.selection.id), null);
  } else {
    commitChange(deleteArrowFromData(state.data, state.selection.id), null);
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

function markDirty(): void {
  if (state.currentMapPath) {
    updateWorkspaceMapData(workspace, state.currentMapPath, state.data);
  }
  lastOperationAt = Date.now();
  void saveLocalSnapshot().catch((error) => {
    console.error(error);
  });
}

function commitChange(data: MindMapState["data"], selection: MindMapSelection): void {
  undoStack.push(state.data);
  redoStack = [];
  state.data = data;
  state.selection = selection;
  markDirty();
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
  markDirty();
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
  markDirty();
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
    renderLibrary();
    return;
  }

  try {
    clearCurrentMap();
    workspace = createEmptyMindMapWorkspace();
    librarySelection = null;
    renderLibrary();
    const settings = requireSettings();

    if (settings) {
      await refreshLocalFromGitHub(settings);
    }
  } catch (error) {
    console.error(error);
  }
});

elements.clearSettingsBtn.addEventListener("click", () => {
  clearPrivateDataSettings(SETTINGS_STORAGE_OPTIONS);
  fillSettingsForm(elements, loadSettings());
  workspace = createEmptyMindMapWorkspace();
  librarySelection = null;
  renderLibrary();
});

elements.addNodeBtn.addEventListener("click", () => {
  void addNode().catch((error) => {
    console.error(error);
  });
});

elements.refreshLibraryBtn.addEventListener("click", async () => {
  try {
    await refreshLibrary();
  } catch (error) {
    console.error(error);
  }
});

elements.newFolderBtn.addEventListener("click", async () => {
  try {
    await createFolder();
  } catch (error) {
    console.error(error);
  }
});

elements.newMapBtn.addEventListener("click", async () => {
  try {
    await createMap();
  } catch (error) {
    console.error(error);
  }
});

elements.renameEntryBtn.addEventListener("click", async () => {
  try {
    await renameLibraryEntry();
  } catch (error) {
    console.error(error);
  }
});

elements.moveEntryBtn.addEventListener("click", async () => {
  try {
    await moveLibraryEntry();
  } catch (error) {
    console.error(error);
  }
});

elements.deleteEntryBtn.addEventListener("click", async () => {
  try {
    await deleteLibraryEntry();
  } catch (error) {
    console.error(error);
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
      console.error(error);
    });
  }
});

elements.connectBtn.addEventListener("click", () => {
  void ensureFreshBeforeOperation()
    .then(() => {
      setConnectModeEnabled(!connectMode);
    })
    .catch((error) => {
      console.error(error);
    });
});

elements.saveBtn.addEventListener("click", async () => {
  try {
    await persistMindMap();
  } catch (error) {
    console.error(error);
  }
});

elements.refreshBtn.addEventListener("click", async () => {
  try {
    await refreshMindMap();
  } catch (error) {
    console.error(error);
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
    void ensureFreshBeforeOperation();
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
      console.error(error);
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
      console.error(error);
    });
    return;
  }

  if (event.altKey && !commandKey && key === "2") {
    event.preventDefault();
    if (!state.currentMapPath) {
      return;
    }
    void ensureFreshBeforeOperation()
      .then(() => {
        setConnectModeEnabled(true);
      })
      .catch((error) => {
        console.error(error);
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
  console.error(error);
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
    await refreshLocalFromGitHub(settings);
  } catch (error) {
    console.error(error);
  }
}
