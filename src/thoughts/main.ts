import {
  addNote as addNoteToData,
  createNote,
  deleteNote as deleteNoteFromData,
  getVisibleNotes,
  parseTags,
} from "./notes";
import {
  clearPrivateDataSettings,
  hasCompletePrivateDataSettings,
  loadPrivateDataSettings,
  savePrivateDataSettings,
} from "../shared/privateData/settings";
import type { PrivateDataSettings } from "../shared/privateData/types";
import { loadThoughtData, saveThoughtData } from "./thoughtRepository";
import type { ThoughtState } from "./types";
import {
  clearComposer,
  fillSettingsForm,
  getThoughtsElements,
  readSettingsForm,
  renderNotes,
  setStatus,
} from "./view";
import "./style.css";

const DEFAULT_THOUGHTS_DATA_SETTINGS: Partial<PrivateDataSettings> = {
  path: "data/thoughts.json",
};

const elements = getThoughtsElements();
let state: ThoughtState = {
  sha: null,
  data: {
    notes: [],
  },
};

function loadSettings(): PrivateDataSettings {
  return loadPrivateDataSettings(DEFAULT_THOUGHTS_DATA_SETTINGS);
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
  renderNotes(elements, getVisibleNotes(state.data, elements.searchInput.value), deleteNote);
}

async function refreshThoughts(): Promise<void> {
  const settings = requireSettings();

  if (!settings) {
    render();
    return;
  }

  setStatus(elements, "正在从 GitHub 读取...");

  const result = await loadThoughtData(settings);
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

async function persistThoughts(message: string): Promise<void> {
  const settings = requireSettings();

  if (!settings) {
    return;
  }

  setStatus(elements, "正在保存到 GitHub...");
  state.sha = await saveThoughtData(settings, state.data, state.sha, message);
  setStatus(elements, `已保存：${new Date().toLocaleString()}`);
}

async function addNote(): Promise<void> {
  const content = elements.thoughtInput.value.trim();

  if (!content) {
    setStatus(elements, "先写点内容。");
    return;
  }

  const note = createNote(content, parseTags(elements.tagInput.value));
  state.data = addNoteToData(state.data, note);
  clearComposer(elements);
  render();

  try {
    await persistThoughts("add thought");
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
}

async function deleteNote(id: string): Promise<void> {
  const ok = confirm("确定删除这条想法吗？");

  if (!ok) {
    return;
  }

  state.data = deleteNoteFromData(state.data, id);
  render();

  try {
    await persistThoughts("delete thought");
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
    await refreshThoughts();
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
  void addNote();
});

elements.refreshBtn.addEventListener("click", async () => {
  try {
    await refreshThoughts();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  }
});

elements.searchInput.addEventListener("input", render);

fillSettingsForm(elements, loadSettings());
void refreshThoughts().catch((error) => {
  setStatus(elements, getErrorMessage(error));
});
