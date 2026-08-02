import { DASHBOARD_REPOSITORY_CONFIG } from "../config";
import type { AuthSession } from "../auth";
import { isProfileId } from "../identifiers";
import type {
  DashboardAccount,
  DashboardProfileContext,
  DashboardProfileState,
  StoredDashboardAccount,
} from "./types";

const PROFILE_STORAGE_KEY = "my-dashboard.profiles.v1";

interface StoredProfileState {
  readonly accounts: readonly StoredDashboardAccount[];
  readonly activeAccountId: string;
}

export interface DashboardProfileStore {
  getState(): DashboardProfileState;
  getActiveContext(): DashboardProfileContext;
  addAccount(session: AuthSession, accountId?: string): DashboardAccount;
  selectAccount(accountId: string): DashboardAccount;
  removeAccount(accountId: string): void;
  hasAccounts(): boolean;
}

export function createDashboardProfileStore(
  storage: Storage = localStorage,
): DashboardProfileStore {
  const read = (): StoredProfileState | null => readStoredState(storage);

  return {
    getState(): DashboardProfileState {
      const stored = read();
      if (!stored) {
        return {
          mode: "local",
          accounts: [],
          activeAccountId: null,
        };
      }
      return {
        mode: "accounts",
        accounts: stored.accounts.map(toPublicAccount),
        activeAccountId: stored.activeAccountId,
      };
    },

    getActiveContext(): DashboardProfileContext {
      const stored = read();
      if (!stored) {
        return { mode: "local", profileId: "local" };
      }
      const active = stored.accounts.find(
        (account) => account.id === stored.activeAccountId,
      );
      if (!active) {
        storage.removeItem(PROFILE_STORAGE_KEY);
        return { mode: "local", profileId: "local" };
      }
      return {
        mode: "account",
        profileId: active.id,
        account: toPublicAccount(active),
        session: toSession(active),
      };
    },

    addAccount(session: AuthSession, accountId = crypto.randomUUID()): DashboardAccount {
      const id = normalizeProfileId(accountId);
      const username = session.credentials.username.trim();
      const stored = read();
      const accounts = stored ? [...stored.accounts] : [];
      const duplicate = accounts.find(
        (account) => account.username.toLocaleLowerCase("en-US")
          === username.toLocaleLowerCase("en-US"),
      );
      if (duplicate) {
        throw new Error("该 GitHub 账户已经添加。");
      }
      const account: StoredDashboardAccount = {
        id,
        username,
        credentials: {
          username,
          token: session.credentials.token,
        },
      };
      accounts.push(account);
      writeStoredState(storage, {
        accounts,
        activeAccountId: id,
      });
      return toPublicAccount(account);
    },

    selectAccount(accountId: string): DashboardAccount {
      const stored = read();
      if (!stored) {
        throw new Error("当前没有可选择的账户。");
      }
      const account = stored.accounts.find((candidate) => candidate.id === accountId);
      if (!account) {
        throw new Error("找不到要选择的账户。");
      }
      writeStoredState(storage, {
        accounts: stored.accounts,
        activeAccountId: account.id,
      });
      return toPublicAccount(account);
    },

    removeAccount(accountId: string): void {
      const stored = read();
      if (!stored) return;
      const accounts = stored.accounts.filter((account) => account.id !== accountId);
      if (accounts.length === stored.accounts.length) return;
      if (accounts.length === 0) {
        storage.removeItem(PROFILE_STORAGE_KEY);
        return;
      }
      writeStoredState(storage, {
        accounts,
        activeAccountId:
          stored.activeAccountId === accountId
            ? accounts[0]!.id
            : stored.activeAccountId,
      });
    },

    hasAccounts(): boolean {
      return read() !== null;
    },
  };
}

function readStoredState(storage: Storage): StoredProfileState | null {
  const serialized = storage.getItem(PROFILE_STORAGE_KEY);
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as {
      accounts?: unknown;
      activeAccountId?: unknown;
    };
    if (!Array.isArray(value.accounts) || typeof value.activeAccountId !== "string") {
      return null;
    }
    const accounts = value.accounts.map(parseAccount);
    if (
      accounts.length === 0
      || new Set(accounts.map((account) => account.id)).size !== accounts.length
      || new Set(accounts.map((account) => account.username.toLocaleLowerCase("en-US"))).size
        !== accounts.length
      || !accounts.some((account) => account.id === value.activeAccountId)
    ) {
      return null;
    }
    return {
      accounts,
      activeAccountId: value.activeAccountId,
    };
  } catch {
    return null;
  }
}

function parseAccount(value: unknown): StoredDashboardAccount {
  if (!value || typeof value !== "object") {
    throw new TypeError("Invalid dashboard account.");
  }
  const record = value as Partial<StoredDashboardAccount>;
  const id = normalizeProfileId(record.id);
  const username = record.username?.trim();
  const credentialUsername = record.credentials?.username?.trim();
  const token = record.credentials?.token?.trim();
  if (
    !username
    || !credentialUsername
    || !token
    || username.toLocaleLowerCase("en-US")
      !== credentialUsername.toLocaleLowerCase("en-US")
  ) {
    throw new TypeError("Invalid dashboard account credentials.");
  }
  return {
    id,
    username,
    credentials: {
      username: credentialUsername,
      token,
    },
  };
}

function writeStoredState(storage: Storage, state: StoredProfileState): void {
  storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(state));
}

function toPublicAccount(account: StoredDashboardAccount): DashboardAccount {
  return {
    id: account.id,
    username: account.username,
  };
}

function toSession(account: StoredDashboardAccount): AuthSession {
  return {
    credentials: {
      username: account.credentials.username,
      token: account.credentials.token,
    },
    repository: {
      ...DASHBOARD_REPOSITORY_CONFIG,
      owner: account.username,
    },
  };
}

function normalizeProfileId(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("A profile id is required.");
  }
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!isProfileId(normalized)) {
    throw new TypeError("Invalid profile id.");
  }
  return normalized;
}
