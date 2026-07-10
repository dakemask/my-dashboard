import { describe, expect, it, vi } from "vitest";
import { createAuthService } from "../../src/shared/auth/authService";
import { createCredentialsStore } from "../../src/shared/auth/credentialsStore";
import { AuthenticationError } from "../../src/shared/auth/types";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function createSuccessfulFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/user")) {
      return Response.json({ login: "octocat" });
    }
    if (url.includes("/git/ref/heads/main")) {
      return Response.json({ ref: "refs/heads/main" });
    }
    return Response.json({
      private: true,
      owner: { login: "octocat" },
      permissions: { pull: true, push: true },
    });
  }) as unknown as typeof fetch;
}

describe("AuthService", () => {
  it("persists credentials only after every validation request succeeds", async () => {
    const storage = createMemoryStorage();
    const store = createCredentialsStore(storage);
    const request = createSuccessfulFetch();
    const service = createAuthService({ credentialsStore: store, fetch: request });

    const session = await service.login({ username: " octocat ", token: " secret-token " });

    expect(session.repository).toEqual({ owner: "octocat", repository: "my-dashboard-data", branch: "main" });
    expect(store.load()).toEqual({ username: "octocat", token: "secret-token" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not persist a failed login or expose the token in its error", async () => {
    const storage = createMemoryStorage();
    const store = createCredentialsStore(storage);
    const request = vi.fn(async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const service = createAuthService({ credentialsStore: store, fetch: request });

    const login = service.login({ username: "octocat", token: "do-not-expose" });

    await expect(login).rejects.toBeInstanceOf(AuthenticationError);
    await expect(login).rejects.not.toThrow(/do-not-expose/);
    expect(store.load()).toBeNull();
  });

  it("restores a previously validated session and invalidates it on demand", async () => {
    const storage = createMemoryStorage();
    const store = createCredentialsStore(storage);
    store.save({ username: "octocat", token: "remembered" });
    const service = createAuthService({ credentialsStore: store, fetch: createSuccessfulFetch() });

    expect(service.restore()?.credentials.username).toBe("octocat");
    expect(service.getState().status).toBe("authenticated");

    service.invalidate();
    expect(service.getState()).toEqual({ status: "anonymous" });
    expect(store.load()).toBeNull();
  });

  it("rejects a token belonging to a different account", async () => {
    const storage = createMemoryStorage();
    const request = vi.fn(async () => Response.json({ login: "someone-else" })) as unknown as typeof fetch;
    const service = createAuthService({ credentialsStore: createCredentialsStore(storage), fetch: request });

    await expect(service.login({ username: "octocat", token: "secret" })).rejects.toThrow(
      "GitHub 用户名与 token 所属账号不一致。",
    );
  });

  it("rejects a repository that is no longer owned by the authenticated user", async () => {
    const storage = createMemoryStorage();
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/user")) {
        return Response.json({ login: "octocat" });
      }
      return Response.json({
        private: true,
        owner: { login: "new-owner" },
        permissions: { pull: true, push: true },
      });
    }) as unknown as typeof fetch;
    const store = createCredentialsStore(storage);
    const service = createAuthService({ credentialsStore: store, fetch: request });

    await expect(service.login({ username: "octocat", token: "secret" })).rejects.toThrow(
      "数据仓库不属于当前 GitHub 用户。",
    );
    expect(store.load()).toBeNull();
  });
});
