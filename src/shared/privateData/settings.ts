import type { PrivateDataSettings } from "./types";

const DEFAULT_SETTINGS: PrivateDataSettings = {
  owner: "",
  repo: "my-dashboard-data",
  branch: "main",
  path: "",
  token: "",
};

const STORAGE_KEYS: Record<keyof PrivateDataSettings, string> = {
  owner: "private_data_owner",
  repo: "private_data_repo",
  branch: "private_data_branch",
  path: "private_data_path",
  token: "private_data_token",
};

export function loadPrivateDataSettings(
  defaults: Partial<PrivateDataSettings> = {},
  storage: Storage = localStorage,
): PrivateDataSettings {
  const fallback = {
    ...DEFAULT_SETTINGS,
    ...defaults,
  };

  return {
    owner: storage.getItem(STORAGE_KEYS.owner) || fallback.owner,
    repo: storage.getItem(STORAGE_KEYS.repo) || fallback.repo,
    branch: storage.getItem(STORAGE_KEYS.branch) || fallback.branch,
    path: storage.getItem(STORAGE_KEYS.path) || fallback.path,
    token: storage.getItem(STORAGE_KEYS.token) || fallback.token,
  };
}

export function savePrivateDataSettings(settings: PrivateDataSettings, storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEYS.owner, settings.owner.trim());
  storage.setItem(STORAGE_KEYS.repo, settings.repo.trim());
  storage.setItem(STORAGE_KEYS.branch, settings.branch.trim());
  storage.setItem(STORAGE_KEYS.path, settings.path.trim());
  storage.setItem(STORAGE_KEYS.token, settings.token.trim());
}

export function clearPrivateDataSettings(storage: Storage = localStorage): void {
  Object.values(STORAGE_KEYS).forEach((key) => {
    storage.removeItem(key);
  });
}

export function hasCompletePrivateDataSettings(settings: PrivateDataSettings): boolean {
  return Boolean(settings.owner && settings.repo && settings.branch && settings.path && settings.token);
}
