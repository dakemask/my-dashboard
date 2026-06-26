import type { ThoughtSettings } from "./types";

const DEFAULT_SETTINGS: ThoughtSettings = {
  owner: "",
  repo: "my-dashboard-data",
  branch: "main",
  path: "data/thoughts.json",
  token: "",
};

const STORAGE_KEYS: Record<keyof ThoughtSettings, string> = {
  owner: "thought_owner",
  repo: "thought_repo",
  branch: "thought_branch",
  path: "thought_path",
  token: "thought_token",
};

export function loadSettings(storage: Storage = localStorage): ThoughtSettings {
  return {
    owner: storage.getItem(STORAGE_KEYS.owner) || DEFAULT_SETTINGS.owner,
    repo: storage.getItem(STORAGE_KEYS.repo) || DEFAULT_SETTINGS.repo,
    branch: storage.getItem(STORAGE_KEYS.branch) || DEFAULT_SETTINGS.branch,
    path: storage.getItem(STORAGE_KEYS.path) || DEFAULT_SETTINGS.path,
    token: storage.getItem(STORAGE_KEYS.token) || DEFAULT_SETTINGS.token,
  };
}

export function saveSettings(settings: ThoughtSettings, storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEYS.owner, settings.owner.trim());
  storage.setItem(STORAGE_KEYS.repo, settings.repo.trim());
  storage.setItem(STORAGE_KEYS.branch, settings.branch.trim());
  storage.setItem(STORAGE_KEYS.path, settings.path.trim());
  storage.setItem(STORAGE_KEYS.token, settings.token.trim());
}

export function clearSettings(storage: Storage = localStorage): void {
  Object.values(STORAGE_KEYS).forEach((key) => {
    storage.removeItem(key);
  });
}

export function hasCompleteSettings(settings: ThoughtSettings): boolean {
  return Boolean(settings.owner && settings.repo && settings.branch && settings.path && settings.token);
}
