import type { GitHubCredentials } from "./types";

const CREDENTIALS_STORAGE_KEY = "my-dashboard.github.credentials";

export interface CredentialsStore {
  load(): GitHubCredentials | null;
  save(credentials: GitHubCredentials): void;
  clear(): void;
}

export function createCredentialsStore(storage: Storage = localStorage): CredentialsStore {
  return {
    load(): GitHubCredentials | null {
      const serialized = storage.getItem(CREDENTIALS_STORAGE_KEY);

      if (!serialized) {
        return null;
      }

      try {
        const value = JSON.parse(serialized) as Partial<GitHubCredentials>;
        if (typeof value.username !== "string" || typeof value.token !== "string") {
          return null;
        }

        const credentials = normalizeCredentials(value as GitHubCredentials);
        return credentials.username && credentials.token ? credentials : null;
      } catch {
        return null;
      }
    },

    save(credentials: GitHubCredentials): void {
      storage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(normalizeCredentials(credentials)));
    },

    clear(): void {
      storage.removeItem(CREDENTIALS_STORAGE_KEY);
    },
  };
}

function normalizeCredentials(credentials: GitHubCredentials): GitHubCredentials {
  return {
    username: credentials.username.trim(),
    token: credentials.token.trim(),
  };
}
