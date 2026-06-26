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

interface PrivateDataSettingsStorageOptions {
  storage?: Storage;
  pathStorageKey?: string;
}

export function loadPrivateDataSettings(
  defaults: Partial<PrivateDataSettings> = {},
  storageOrOptions: Storage | PrivateDataSettingsStorageOptions = localStorage,
): PrivateDataSettings {
  const { storage, keys } = resolveStorageOptions(storageOrOptions);
  const fallback = {
    ...DEFAULT_SETTINGS,
    ...defaults,
  };

  return {
    owner: storage.getItem(keys.owner) || fallback.owner,
    repo: storage.getItem(keys.repo) || fallback.repo,
    branch: storage.getItem(keys.branch) || fallback.branch,
    path: storage.getItem(keys.path) || fallback.path,
    token: storage.getItem(keys.token) || fallback.token,
  };
}

export function savePrivateDataSettings(
  settings: PrivateDataSettings,
  storageOrOptions: Storage | PrivateDataSettingsStorageOptions = localStorage,
): void {
  const { storage, keys } = resolveStorageOptions(storageOrOptions);

  storage.setItem(keys.owner, settings.owner.trim());
  storage.setItem(keys.repo, settings.repo.trim());
  storage.setItem(keys.branch, settings.branch.trim());
  storage.setItem(keys.path, settings.path.trim());
  storage.setItem(keys.token, settings.token.trim());
}

export function clearPrivateDataSettings(
  storageOrOptions: Storage | PrivateDataSettingsStorageOptions = localStorage,
): void {
  const { storage, keys } = resolveStorageOptions(storageOrOptions);

  Object.values(keys).forEach((key) => {
    storage.removeItem(key);
  });
}

export function hasCompletePrivateDataSettings(settings: PrivateDataSettings): boolean {
  return Boolean(settings.owner && settings.repo && settings.branch && settings.path && settings.token);
}

function resolveStorageOptions(
  storageOrOptions: Storage | PrivateDataSettingsStorageOptions,
): { storage: Storage; keys: Record<keyof PrivateDataSettings, string> } {
  if (isStorage(storageOrOptions)) {
    return {
      storage: storageOrOptions,
      keys: STORAGE_KEYS,
    };
  }

  return {
    storage: storageOrOptions.storage ?? localStorage,
    keys: {
      ...STORAGE_KEYS,
      path: storageOrOptions.pathStorageKey ?? STORAGE_KEYS.path,
    },
  };
}

function isStorage(value: Storage | PrivateDataSettingsStorageOptions): value is Storage {
  return "getItem" in value && "setItem" in value && "removeItem" in value;
}
