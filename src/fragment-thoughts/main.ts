import {
  addFragmentThought as addFragmentThoughtToData,
  createFragmentThought,
  deleteFragmentThought as deleteFragmentThoughtFromData,
  getVisibleFragmentThoughts,
  parseTags,
} from "./fragmentThoughts";
import {
  clearPrivateDataSettings,
  hasCompletePrivateDataSettings,
  loadPrivateDataSettings,
  savePrivateDataSettings,
} from "../shared/privateData/settings";
import type { PrivateDataSettings } from "../shared/privateData/types";
import { loadFragmentThoughtData, saveFragmentThoughtData } from "./fragmentThoughtRepository";
import type { FragmentThoughtState } from "./types";
import {
  clearComposer,
  fillSettingsForm,
  getFragmentThoughtsElements,
  readSettingsForm,
  renderFragmentThoughts,
  setStatus,
} from "./view";
import "./style.css";

const DEFAULT_FRAGMENT_THOUGHTS_DATA_SETTINGS: Partial<PrivateDataSettings> = {
  path: "fragment-thoughts/fragment-thoughts.json",
};

const elements = getFragmentThoughtsElements();
let state: FragmentThoughtState = {
  sha: null,
  data: {
    notes: [],
  },
};

function loadSettings(): PrivateDataSettings {
  return loadPrivateDataSettings(DEFAULT_FRAGMENT_THOUGHTS_DATA_SETTINGS);
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
  renderFragmentThoughts(
    elements,
    getVisibleFragmentThoughts(state.data, elements.searchInput.value),
    deleteFragmentThought,
  );
}

async function refreshFragmentThoughts(): Promise<void> {
  const settings = requireSettings();

  if (!settings) {
    render();
    return;
  }

  setStatus(elements, "正在从 GitHub 读取...");

  const result = await loadFragmentThoughtData(settings);
  state = {
    sha: result.sha,
    data: result.data,
  };

  setStatus(
    elements,
    result.created ? "数据文件还不存在。保存第一条想法时会自动创建。" : `已同步：${new Date().toLocaleString()}`,
  );
  render();
}

async function persistFragmentThoughts(message: string): Promise<void> {
  const settings = requireSettings();

  if (!settings) {
    return;
  }

  setStatus(elements, "正在保存到 GitHub...");
  state.sha = await saveFragmentThoughtData(settings, state.data, state.sha, message);
  setStatus(elements, `已保存：${new Date().toLocaleString()}`);
}

async function addFragmentThought(): Promise<void> {
  const content = elements.thoughtInput.value.trim();

  if (!content) {
    setStatus(elements, "先写点内容。");
    return;
  }

  const fragmentThought = createFragmentThought(content, parseTags(elements.tagInput.value));
  state.data = addFragmentThoughtToData(state.data, fragmentThought);
  clearComposer(elements);
  render();

  try {
    await persistFragmentThoughts("add fragment thought");
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
}

async function deleteFragmentThought(id: string): Promise<void> {
  const ok = confirm("确定删除这条想法吗？");

  if (!ok) {
    return;
  }

  state.data = deleteFragmentThoughtFromData(state.data, id);
  render();

  try {
    await persistFragmentThoughts("delete fragment thought");
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

elements.settingsBtn.addEventListener("click", () => {
  elements.settingsPanel.classList.toggle("hidden");
});

elements.saveSettingsBtn.addEventListener("click", async () => {
  savePrivateDataSettings(readSettingsForm(elements));
  setStatus(elements, "设置已保存。");

  try {
    await refreshFragmentThoughts();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.clearSettingsBtn.addEventListener("click", () => {
  clearPrivateDataSettings();
  fillSettingsForm(elements, loadSettings());
  setStatus(elements, "已清除当前浏览器里的设置。");
});

elements.addBtn.addEventListener("click", () => {
  void addFragmentThought();
});

elements.refreshBtn.addEventListener("click", async () => {
  try {
    await refreshFragmentThoughts();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.searchInput.addEventListener("input", render);

fillSettingsForm(elements, loadSettings());
void refreshFragmentThoughts().catch((error) => {
  setStatus(elements, getErrorMessage(error));
});
