import { describe, expect, it } from "vitest";

import { createDashboardProfileStore } from "../../src/shared/profiles";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const octocat = {
  credentials: { username: "octocat", token: "octocat-token" },
  repository: {
    owner: "octocat",
    repository: "my-dashboard-data",
    branch: "main",
  },
};

const monalisa = {
  credentials: { username: "monalisa", token: "monalisa-token" },
  repository: {
    owner: "monalisa",
    repository: "my-dashboard-data",
    branch: "main",
  },
};

describe("DashboardProfileStore", () => {
  it("defaults to a local profile when no registry exists", () => {
    const store = createDashboardProfileStore(new MemoryStorage());

    expect(store.getState()).toEqual({
      mode: "local",
      accounts: [],
      activeAccountId: null,
    });
    expect(store.getActiveContext()).toEqual({
      mode: "local",
      profileId: "local",
    });
  });

  it("stores multiple accounts, switches the active account, and keeps tokens private", () => {
    const storage = new MemoryStorage();
    const store = createDashboardProfileStore(storage);

    store.addAccount(octocat, "github-octocat");
    store.addAccount(monalisa, "github-monalisa");
    expect(store.getState()).toEqual({
      mode: "accounts",
      accounts: [
        { id: "github-octocat", username: "octocat" },
        { id: "github-monalisa", username: "monalisa" },
      ],
      activeAccountId: "github-monalisa",
    });
    expect(store.getState()).not.toHaveProperty("accounts.0.credentials");

    store.selectAccount("github-octocat");
    expect(store.getActiveContext()).toMatchObject({
      mode: "account",
      profileId: "github-octocat",
      account: { username: "octocat" },
      session: {
        credentials: { username: "octocat", token: "octocat-token" },
      },
    });
  });

  it("rejects adding the same GitHub username twice", () => {
    const store = createDashboardProfileStore(new MemoryStorage());
    store.addAccount(octocat, "github-octocat");

    expect(() => store.addAccount({
      ...octocat,
      credentials: { username: "OctoCat", token: "replacement" },
    }, "github-octocat-two")).toThrow("已经添加");
  });
});
