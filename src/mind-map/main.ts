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
import { MindMapCanvas } from "./canvasView";
import {
  clearPrivateDataSettings,
  hasCompletePrivateDataSettings,
  loadPrivateDataSettings,
  savePrivateDataSettings,
} from "../shared/privateData/settings";
import type { PrivateDataSettings } from "../shared/privateData/types";
import { loadMindMapData, saveMindMapData } from "./mindMapRepository";
import { fitNodeFrameToText } from "./textLayout";
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
const canvas = new MindMapCanvas(elements.canvasHost, {
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

function loadSettings(): PrivateDataSettings {
  return loadPrivateDataSettings(DEFAULT_MIND_MAP_DATA_SETTINGS, SETTINGS_STORAGE_OPTIONS);
}

function requireSettings(): PrivateDataSettings | null {
  const settings = loadSettings();

  if (!hasCompletePrivateDataSettings(settings)) {
    elements.settingsPanel.classList.remove("hidden");
    setStatus(elements, "请先完成同步设置。");
    return null;
  }

  return settings;
}

function render(): void {
  canvas.render(state.data, state.selection);
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
  const position = canvas.getNewNodePosition();
  const node = createMindMapNode(position.x, position.y);
  state.data = addNodeToData(state.data, node);
  state.selection = {
    type: "node",
    id: node.id,
  };
  markDirty("已新增框，尚未保存。");
  render();
  requestAnimationFrame(() => canvas.editNodeText(node.id));
}

function changeNodeFrame(id: string, frame: NodeFrame): void {
  const node = findNode(state.data, id);

  if (!node) {
    return;
  }

  state.data = updateNodeFrame(state.data, id, fitNodeFrameToText(frame, node.text));
  state.selection = {
    type: "node",
    id,
  };
  markDirty("已调整框，尚未保存。");
  render();
}

function changeNodeText(id: string, text: string): void {
  const node = findNode(state.data, id);

  if (!node) {
    return;
  }

  const frame = fitNodeFrameToText(
    {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    },
    text,
  );
  state.data = updateNodeText(state.data, id, text, frame);
  state.selection = {
    type: "node",
    id,
  };
  markDirty("已编辑文字，尚未保存。");
  render();
}

function createArrow(from: MindMapEndpoint, to: MindMapEndpoint): void {
  const next = addArrowToData(state.data, createMindMapArrow(from, to));

  if (next === state.data) {
    return;
  }

  state.data = next;
  state.selection = {
    type: "arrow",
    id: state.data.arrows[state.data.arrows.length - 1].id,
  };
  markDirty("已新增箭头，尚未保存。");
  render();
}

function deleteSelection(): void {
  if (!state.selection) {
    return;
  }

  if (state.selection.type === "node") {
    state.data = deleteNodeFromData(state.data, state.selection.id);
    markDirty("已删除框，尚未保存。");
  } else {
    state.data = deleteArrowFromData(state.data, state.selection.id);
    markDirty("已删除箭头，尚未保存。");
  }

  state.selection = null;
  hideContextMenu(elements);
  render();
}

function setSelection(selection: MindMapSelection): void {
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
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
  connectMode = !connectMode;
  setConnectMode(elements, connectMode);
  canvas.setConnectMode(connectMode);
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

elements.contextDeleteBtn.addEventListener("click", deleteSelection);

document.addEventListener("click", (event) => {
  if (!elements.contextMenu.contains(event.target as Node)) {
    hideContextMenu(elements);
  }
});

document.addEventListener("keydown", (event) => {
  if (isEditableTarget(event.target) || (event.key !== "Delete" && event.key !== "Backspace")) {
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
setConnectMode(elements, connectMode);
render();
void refreshMindMap().catch((error) => {
  setStatus(elements, getErrorMessage(error));
});
