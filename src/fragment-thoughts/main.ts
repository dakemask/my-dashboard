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
import {
  createPrivateDataRevisionPoller,
  getPrivateDataFileParentPath,
  loadPrivateDataRevision,
  savePrivateDataRevision,
  type LoadedPrivateDataRevision,
} from "../shared/privateData/revision";
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
  setSyncOverlayVisible,
} from "./view";
import "./style.css";

const DEFAULT_FRAGMENT_THOUGHTS_DATA_SETTINGS: Partial<PrivateDataSettings> = {
  path: "data/fragment-thoughts/fragment-thoughts.json",
};

const elements = getFragmentThoughtsElements();
let state: FragmentThoughtState = {
  sha: null,
  data: {
    notes: [],
  },
};
let knownRevision: string | null = null;
let hasDirtyChanges = false;
let saveInProgress = false;
let queuedSaveMessage: string | null = null;
let refreshInProgress = false;
let revisionConflictInProgress = false;

const revisionPoller = createPrivateDataRevisionPoller({
  getSettings: getCompleteSettings,
  getModuleRoot: getFragmentThoughtModuleRoot,
  getKnownRevision: () => knownRevision,
  onRevisionChange: handleRemoteRevisionChange,
  onError: (error) => {
    setStatus(elements, getErrorMessage(error));
  },
});

function loadSettings(): PrivateDataSettings {
  return loadPrivateDataSettings(DEFAULT_FRAGMENT_THOUGHTS_DATA_SETTINGS);
}

function getCompleteSettings(): PrivateDataSettings | null {
  const settings = loadSettings();

  return hasCompletePrivateDataSettings(settings) ? settings : null;
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

function getFragmentThoughtModuleRoot(settings: PrivateDataSettings): string {
  return getPrivateDataFileParentPath(settings.path);
}

async function refreshFragmentThoughts(options: { discardDirty?: boolean } = {}): Promise<void> {
  if (refreshInProgress) {
    return;
  }

  const settings = requireSettings();

  if (!settings) {
    render();
    return;
  }

  if (hasDirtyChanges && !options.discardDirty) {
    const ok = confirm("从 GitHub 刷新会放弃当前未保存的本地修改。继续吗？");

    if (!ok) {
      return;
    }
  }

  refreshInProgress = true;
  setSyncOverlayVisible(elements, true);

  try {
    const [result, revision] = await Promise.all([
      loadFragmentThoughtData(settings),
      loadPrivateDataRevision(settings, getFragmentThoughtModuleRoot(settings)),
    ]);

    state = {
      sha: result.sha,
      data: result.data,
    };
    knownRevision = revision?.data.revision ?? null;
    hasDirtyChanges = false;

    setStatus(
      elements,
      result.created ? "数据文件还不存在。保存第一条想法时会自动创建。" : `已同步：${new Date().toLocaleString()}`,
    );
    render();
  } finally {
    refreshInProgress = false;
    setSyncOverlayVisible(elements, false);
  }
}

async function persistFragmentThoughts(
  message: string,
  options: { refreshRemoteSha?: boolean } = {},
): Promise<void> {
  if (saveInProgress) {
    queuedSaveMessage = message;
    return;
  }

  const settings = requireSettings();

  if (!settings) {
    return;
  }

  saveInProgress = true;
  let savedSuccessfully = false;
  setSyncOverlayVisible(elements, true);

  try {
    const dataToSave = state.data;
    const remoteSha = options.refreshRemoteSha ? (await loadFragmentThoughtData(settings)).sha : state.sha;

    state.sha = await saveFragmentThoughtData(settings, dataToSave, remoteSha, message);

    const revision = await savePrivateDataRevision(
      settings,
      getFragmentThoughtModuleRoot(settings),
      "update fragment thoughts revision",
    );

    knownRevision = revision.data.revision;
    hasDirtyChanges = state.data !== dataToSave;
    savedSuccessfully = true;
    setStatus(elements, `已保存：${new Date().toLocaleString()}`);
  } finally {
    saveInProgress = false;

    const nextMessage = queuedSaveMessage;

    queuedSaveMessage = null;

    if (savedSuccessfully && nextMessage && hasDirtyChanges) {
      void persistFragmentThoughts(nextMessage).catch((error) => {
        setStatus(elements, getErrorMessage(error));
      });
      return;
    }

    setSyncOverlayVisible(elements, false);
  }
}

async function handleRemoteRevisionChange(revision: LoadedPrivateDataRevision): Promise<void> {
  if (revision.data.revision === knownRevision) {
    return;
  }

  if (saveInProgress || refreshInProgress || revisionConflictInProgress) {
    return;
  }

  if (!hasDirtyChanges) {
    await refreshFragmentThoughts({ discardDirty: true });
    return;
  }

  revisionConflictInProgress = true;

  try {
    const shouldUploadLocal = confirm(
      "Fragment Thoughts 的远程数据已更新。\n\n确定：保存本地未同步修改并上传新版本。\n取消：放弃本地未同步修改并拉取远程数据。",
    );

    if (shouldUploadLocal) {
      await persistFragmentThoughts("resolve fragment thoughts revision conflict", { refreshRemoteSha: true });
    } else {
      await refreshFragmentThoughts({ discardDirty: true });
    }
  } finally {
    revisionConflictInProgress = false;
  }
}

async function addFragmentThought(): Promise<void> {
  const content = elements.thoughtInput.value.trim();

  if (!content) {
    setStatus(elements, "先写点内容。");
    return;
  }

  const fragmentThought = createFragmentThought(content, parseTags(elements.tagInput.value));
  state.data = addFragmentThoughtToData(state.data, fragmentThought);
  hasDirtyChanges = true;
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
  hasDirtyChanges = true;
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
  knownRevision = null;
  revisionPoller.stop();
  setStatus(elements, "设置已保存。");

  try {
    await refreshFragmentThoughts();
  } catch (error) {
    setStatus(elements, getErrorMessage(error));
  } finally {
    revisionPoller.start();
  }
});

elements.clearSettingsBtn.addEventListener("click", () => {
  clearPrivateDataSettings();
  knownRevision = null;
  revisionPoller.stop();
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
void initializeFragmentThoughts().catch((error) => {
  setStatus(elements, getErrorMessage(error));
});

async function initializeFragmentThoughts(): Promise<void> {
  try {
    await refreshFragmentThoughts({ discardDirty: true });
  } finally {
    revisionPoller.start();
  }
}
