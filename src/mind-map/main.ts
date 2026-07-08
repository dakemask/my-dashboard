import {
  addArrow as addArrowToData,
  addNode as addNodeToData,
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
import { loadMindMapData, saveMindMapData } from "./mindMapRepository";
import type { MindMapEndpoint, MindMapSelection, MindMapState, NodeFrame } from "./types";
import {
  fillSettingsForm,
  getMindMapElements,
  hideContextMenu,
  readSettingsForm,
  setConnectMode,
  setStatus,
  showContextMenu,
} from "./view";
import "./style.css";

const DEFAULT_MIND_MAP_DATA_SETTINGS: Partial<PrivateDataSettings> = {
  path: "data/mind-map.json",
};
const SETTINGS_STORAGE_OPTIONS = {
  pathStorageKey: "private_data_mind_map_path",
};

const elements = getMindMapElements();
const mapView = new MindMapView(elements.mapHost, {
  onSelectionChange: setSelection,
  onNodeFrameChange: changeNodeFrame,
  onNodeTextChange: changeNodeText,
  onArrowCreate: createArrow,
  onContextMenu: openContextMenu,
});

let state: MindMapState = {
  sha: null,
  dirty: false,
  selection: null,
  data: {
    nodes: [],
    arrows: [],
  },
};
let connectMode = false;
let undoStack: MindMapState["data"][] = [];
let redoStack: MindMapState["data"][] = [];

function loadSettings(): PrivateDataSettings {
  return loadPrivateDataSettings(DEFAULT_MIND_MAP_DATA_SETTINGS, SETTINGS_STORAGE_OPTIONS);
}

function requireSettings(): PrivateDataSettings | null {
  const settings = loadSettings();

  if (!hasCompletePrivateDataSettings(settings)) {
    setStatus(elements, "未配置同步。可以先编辑画布，保存前再点设置填写 GitHub 信息。");
    return null;
  }

  return settings;
}

function render(): void {
  mapView.render(state.data, state.selection);
}

async function refreshMindMap(): Promise<void> {
  if (state.dirty) {
    const ok = confirm("当前画布有未保存修改，刷新会丢失这些修改。继续吗？");

    if (!ok) {
      return;
    }
  }

  const settings = requireSettings();

  if (!settings) {
    render();
    return;
  }

  setStatus(elements, "正在从 GitHub 读取...");

  const result = await loadMindMapData(settings);
  state = {
    sha: result.sha,
    data: result.data,
    dirty: false,
    selection: null,
  };
  undoStack = [];
  redoStack = [];

  setStatus(
    elements,
    result.created ? "数据文件还不存在。保存时会自动创建。" : `已同步：${new Date().toLocaleString()}`,
  );
  render();
}

async function persistMindMap(): Promise<void> {
  const settings = requireSettings();

  if (!settings) {
    return;
  }

  if (!state.dirty) {
    setStatus(elements, "没有需要保存的修改。");
    return;
  }

  setStatus(elements, "正在保存到 GitHub...");
  state.sha = await saveMindMapData(settings, state.data, state.sha, "save mind map");
  state.dirty = false;
  setStatus(elements, `已保存：${new Date().toLocaleString()}`);
}

function addNode(): void {
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
  state.dirty = true;
  setStatus(elements, message);
}

function commitChange(data: MindMapState["data"], selection: MindMapSelection, message: string): void {
  undoStack.push(state.data);
  redoStack = [];
  state.data = data;
  state.selection = selection;
  markDirty(message);
  render();
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

elements.settingsBtn.addEventListener("click", () => {
  elements.settingsPanel.classList.toggle("hidden");
});

elements.saveSettingsBtn.addEventListener("click", async () => {
  savePrivateDataSettings(readSettingsForm(elements), SETTINGS_STORAGE_OPTIONS);
  fillSettingsForm(elements, loadSettings());

  if (state.dirty) {
    setStatus(elements, "设置已保存。当前画布尚未保存。");
    return;
  }

  try {
    await refreshMindMap();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.clearSettingsBtn.addEventListener("click", () => {
  clearPrivateDataSettings(SETTINGS_STORAGE_OPTIONS);
  fillSettingsForm(elements, loadSettings());
  setStatus(elements, "已清除当前浏览器里的设置。");
});

elements.addNodeBtn.addEventListener("click", addNode);

elements.connectBtn.addEventListener("click", () => {
  setConnectModeEnabled(!connectMode);
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
    addNode();
    return;
  }

  if (event.altKey && !commandKey && key === "2") {
    event.preventDefault();
    setConnectModeEnabled(true);
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
  if (!state.dirty) {
    return;
  }

  event.preventDefault();
});

fillSettingsForm(elements, loadSettings());
setConnectModeEnabled(connectMode);
render();
void refreshMindMap().catch((error) => {
  setStatus(elements, getErrorMessage(error));
});
