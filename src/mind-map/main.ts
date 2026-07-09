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
import {
  createPrivateDataRevisionPoller,
  loadPrivateDataRevision,
  savePrivateDataRevision,
  type LoadedPrivateDataRevision,
} from "../shared/privateData/revision";
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
  loadRemoteMindMapWorkspace,
  refreshMindMapWorkspaceRemoteMetadata,
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
  showErrorToast,
} from "./view";
import "./style.css";

const DEFAULT_MIND_MAP_DATA_SETTINGS: Partial<PrivateDataSettings> = {
  path: DEFAULT_MIND_MAP_LIBRARY_ROOT,
};
const SETTINGS_STORAGE_OPTIONS = {
  pathStorageKey: "private_data_mind_map_path",
};

const elements = getMindMapElements();
const mapView = new MindMapView(elements.mapHost, {
  onSelectionChange: setSelection,
  onNodeFrameChange: changeNodeFrame,
  onNodeTextChange: changeNodeText,
  onNodeTextPreview: previewNodeText,
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
let knownRevision: string | null = null;
let knownRevisionSha: string | null = null;
let connectMode = false;
let saveInProgress = false;
let refreshInProgress = false;
let revisionConflictInProgress = false;
let undoStack: MindMapState["data"][] = [];
let redoStack: MindMapState["data"][] = [];
let pendingTextEditUndo: { id: string; data: MindMapState["data"] } | null = null;

const revisionPoller = createPrivateDataRevisionPoller({
  getSettings: getCompleteSettings,
  getModuleRoot: getMindMapModuleRoot,
  getKnownRevision: () => knownRevision,
  onRevisionChange: handleRemoteRevisionChange,
  onError: reportError,
});

function loadSettings(): PrivateDataSettings {
  const settings = loadPrivateDataSettings(DEFAULT_MIND_MAP_DATA_SETTINGS, SETTINGS_STORAGE_OPTIONS);

  return {
    ...settings,
    path: normalizeMindMapLibraryRoot(settings.path),
  };
}

function getCompleteSettings(): PrivateDataSettings | null {
  const settings = loadSettings();

  return hasCompletePrivateDataSettings(settings) ? settings : null;
}

function getMindMapModuleRoot(settings: PrivateDataSettings): string {
  return settings.path;
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

function reportError(error: unknown): void {
  console.error(error);
  showErrorToast(elements, getErrorMessage(error));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (refreshInProgress) {
    return;
  }

  refreshInProgress = true;
  setSaveOverlayVisible(elements, true);

  try {
    const [remoteWorkspace, revision] = await Promise.all([
      loadRemoteMindMapWorkspace(settings),
      loadPrivateDataRevision(settings, getMindMapModuleRoot(settings)),
    ]);

    workspace = remoteWorkspace;
    knownRevision = revision?.data.revision ?? null;
    knownRevisionSha = revision?.sha ?? null;
    syncCurrentMapAfterLocalRefresh();

    render();
    renderLibrary();
  } finally {
    refreshInProgress = false;
    setSaveOverlayVisible(elements, false);
  }
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
    cacheCurrentMapBeforeSwitch();
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

async function persistMindMap(
  options: { allowDuringConflict?: boolean; refreshRemoteMetadata?: boolean } = {},
): Promise<void> {
  if (saveInProgress) {
    return;
  }

  mapView.commitActiveEdit();

  if (!options.allowDuringConflict && !(await ensureFreshBeforeOperation())) {
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

  revisionPoller.stop();
  saveInProgress = true;
  setSaveOverlayVisible(elements, true);

  const dirtyContentPaths = new Set(workspace.dirtyContentPaths);
  const dirtyTree = workspace.dirtyTree;
  const treeChangePaths = new Set(workspace.treeChangePaths);

  try {
    if (options.refreshRemoteMetadata) {
      await refreshMindMapWorkspaceRemoteMetadata(settings, workspace);
    }

    await saveRemoteMindMapWorkspace(settings, workspace);

    try {
      const revision = await savePrivateDataRevision(
        settings,
        getMindMapModuleRoot(settings),
        "update mind map revision",
        knownRevisionSha,
      );

      knownRevision = revision.data.revision;
      knownRevisionSha = revision.sha;
    } catch (error) {
      workspace.dirtyContentPaths = dirtyContentPaths;
      workspace.dirtyTree = dirtyTree;
      workspace.treeChangePaths = treeChangePaths;
      throw error;
    }

    syncCurrentMapAfterLocalRefresh();
    render();
    renderLibrary();
  } finally {
    saveInProgress = false;
    setSaveOverlayVisible(elements, false);
    revisionPoller.start({ immediate: false });
  }
}

function cacheCurrentMapBeforeSwitch(): void {
  if (!state.currentMapPath) {
    return;
  }

  cacheCurrentMap();
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

async function ensureFreshBeforeOperation(): Promise<boolean> {
  if (saveInProgress || refreshInProgress || revisionConflictInProgress) {
    return false;
  }

  return true;
}

async function handleRemoteRevisionChange(revision: LoadedPrivateDataRevision): Promise<void> {
  if (revision.data.revision === knownRevision) {
    return;
  }

  if (saveInProgress || refreshInProgress || revisionConflictInProgress) {
    return;
  }

  const settings = requireSettings();

  if (!settings) {
    return;
  }

  mapView.commitActiveEdit();
  cacheCurrentMap();

  if (!hasUnsavedLocalChanges()) {
    await refreshLocalFromGitHub(settings);
    return;
  }

  revisionConflictInProgress = true;

  try {
    const shouldUploadLocal = confirm(
      "Mind Map 的远程数据已更新。\n\n确定：保存本地未同步修改并上传新版本。\n取消：放弃本地未同步修改并拉取远程数据。",
    );

    if (shouldUploadLocal) {
      knownRevisionSha = revision.sha;
      await persistMindMap({
        allowDuringConflict: true,
        refreshRemoteMetadata: true,
      });
    } else {
      await refreshLocalFromGitHub(settings);
    }
  } finally {
    revisionConflictInProgress = false;
  }
}

function markLibraryChanged(): void {
  render();
  renderLibrary();
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
  cacheCurrentMapBeforeSwitch();
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
    if (result.errorMessage) {
      showErrorToast(elements, result.errorMessage);
    }
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
  const undoData = pendingTextEditUndo?.id === id ? pendingTextEditUndo.data : null;

  if (pendingTextEditUndo?.id === id) {
    pendingTextEditUndo = null;
  }

  const node = findNode(state.data, id);

  if (!node) {
    return;
  }

  const next = updateNodeText(state.data, id, text, frame);

  if (undoData) {
    const originalNode = findNode(undoData, id);
    const nextNode = findNode(next, id);

    state.data = next;

    if (!originalNode || !nextNode || (originalNode.text === nextNode.text && isSameFrame(originalNode, nextNode))) {
      markDirty();
      render();
      renderLibrary();
      return;
    }

    undoStack.push(undoData);
    redoStack = [];
    state.selection = {
      type: "node",
      id,
    };
    markDirty();
    render();
    renderLibrary();
    return;
  }

  if (node.text === text && (!frame || isSameFrame(node, frame))) {
    return;
  }

  commitChange(
    next,
    {
      type: "node",
      id,
    }
  );
}

function previewNodeText(id: string, text: string, frame?: NodeFrame): void {
  const node = findNode(state.data, id);

  if (!node) {
    return;
  }

  if (node.text === text && (!frame || isSameFrame(node, frame))) {
    return;
  }

  if (pendingTextEditUndo?.id !== id) {
    pendingTextEditUndo = {
      id,
      data: state.data,
    };
  }

  state.data = updateNodeText(state.data, id, text, frame);
  markDirty();
  renderDirtyIndicators();
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
}

function renderDirtyIndicators(): void {
  setCurrentMapTitle(
    elements,
    state.currentMapPath ? getMapTitleFromPath(state.currentMapPath) : "未打开导图",
    isCurrentMapDirty(),
  );
  setMapToolsEnabled(elements, Boolean(state.currentMapPath), hasUnsavedLocalChanges());
  renderLibrary();
}

function commitChange(data: MindMapState["data"], selection: MindMapSelection): void {
  pendingTextEditUndo = null;
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

elements.settingsBtn.addEventListener("click", () => {
  elements.settingsPanel.classList.toggle("hidden");
});

elements.saveSettingsBtn.addEventListener("click", async () => {
  savePrivateDataSettings(readNormalizedSettingsForm(), SETTINGS_STORAGE_OPTIONS);
  fillSettingsForm(elements, loadSettings());
  knownRevision = null;
  knownRevisionSha = null;
  revisionPoller.stop();

  if (hasUnsavedLocalChanges()) {
    renderLibrary();
    revisionPoller.start();
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
    reportError(error);
  } finally {
    revisionPoller.start();
  }
});

elements.clearSettingsBtn.addEventListener("click", () => {
  clearPrivateDataSettings(SETTINGS_STORAGE_OPTIONS);
  knownRevision = null;
  knownRevisionSha = null;
  revisionPoller.stop();
  fillSettingsForm(elements, loadSettings());
  workspace = createEmptyMindMapWorkspace();
  librarySelection = null;
  renderLibrary();
});

elements.addNodeBtn.addEventListener("click", () => {
  void addNode().catch((error) => {
    reportError(error);
  });
});

elements.refreshLibraryBtn.addEventListener("click", async () => {
  try {
    await refreshLibrary();
  } catch (error) {
    reportError(error);
  }
});

elements.newFolderBtn.addEventListener("click", async () => {
  try {
    await createFolder();
  } catch (error) {
    reportError(error);
  }
});

elements.newMapBtn.addEventListener("click", async () => {
  try {
    await createMap();
  } catch (error) {
    reportError(error);
  }
});

elements.renameEntryBtn.addEventListener("click", async () => {
  try {
    await renameLibraryEntry();
  } catch (error) {
    reportError(error);
  }
});

elements.moveEntryBtn.addEventListener("click", async () => {
  try {
    await moveLibraryEntry();
  } catch (error) {
    reportError(error);
  }
});

elements.deleteEntryBtn.addEventListener("click", async () => {
  try {
    await deleteLibraryEntry();
  } catch (error) {
    reportError(error);
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
      reportError(error);
    });
  }
});

elements.connectBtn.addEventListener("click", () => {
  void ensureFreshBeforeOperation()
    .then((ok) => {
      if (ok) {
        setConnectModeEnabled(!connectMode);
      }
    })
    .catch((error) => {
      reportError(error);
    });
});

elements.saveBtn.addEventListener("click", async () => {
  try {
    await persistMindMap();
  } catch (error) {
    reportError(error);
  }
});

elements.refreshBtn.addEventListener("click", async () => {
  try {
    await refreshMindMap();
  } catch (error) {
    reportError(error);
  }
});

elements.resetBtn.addEventListener("click", () => {
  mapView.resetView();
});

elements.contextDeleteBtn.addEventListener("click", deleteSelection);

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
      reportError(error);
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
      reportError(error);
    });
    return;
  }

  if (event.altKey && !commandKey && key === "2") {
    event.preventDefault();
    if (!state.currentMapPath) {
      return;
    }
    void ensureFreshBeforeOperation()
      .then((ok) => {
        if (ok) {
          setConnectModeEnabled(true);
        }
      })
      .catch((error) => {
        reportError(error);
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
  reportError(error);
});

async function initializeMindMap(): Promise<void> {
  const settings = requireSettings();

  if (!settings) {
    revisionPoller.start();
    return;
  }

  try {
    await refreshLocalFromGitHub(settings);
  } catch (error) {
    reportError(error);
  } finally {
    revisionPoller.start();
  }
}
