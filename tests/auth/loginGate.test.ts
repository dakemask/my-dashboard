// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { mountLoginGate } from "../../src/shared/auth/loginGate";
import type { AuthService } from "../../src/shared/auth/authService";
import type { AuthSession, AuthState } from "../../src/shared/auth/types";

function createAnonymousService(login: AuthService["login"]): AuthService {
  return {
    getState: () => ({ status: "anonymous" }),
    restore: () => null,
    login,
    invalidate: vi.fn(),
    subscribe: (_listener: (state: AuthState) => void) => () => undefined,
  };
}

describe("mountLoginGate", () => {
  it("renders a password token field and authenticates without displaying the token", async () => {
    const host = document.createElement("div");
    const session: AuthSession = {
      credentials: { username: "octocat", token: "secret-value" },
      repository: { owner: "octocat", repository: "my-dashboard-data", branch: "main" },
    };
    const login = vi.fn(async () => session);
    const authenticated = vi.fn();

    mountLoginGate(host, { authService: createAnonymousService(login), onAuthenticated: authenticated });
    const username = host.querySelector<HTMLInputElement>('input[name="username"]')!;
    const token = host.querySelector<HTMLInputElement>('input[name="token"]')!;
    username.value = "octocat";
    token.value = "secret-value";

    expect(token.type).toBe("password");
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(authenticated).toHaveBeenCalledWith(session));
    expect(host.textContent).not.toContain("secret-value");
  });

  it("returns to the login card when saved credentials are invalidated", () => {
    const host = document.createElement("div");
    const session: AuthSession = {
      credentials: { username: "octocat", token: "remembered" },
      repository: { owner: "octocat", repository: "my-dashboard-data", branch: "main" },
    };
    let state: AuthState = { status: "authenticated", session };
    const listeners = new Set<(next: AuthState) => void>();
    const service: AuthService = {
      getState: () => state,
      restore: () => session,
      login: vi.fn(async () => session),
      invalidate: () => {
        state = { status: "anonymous" };
        listeners.forEach((listener) => listener(state));
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    mountLoginGate(host, { authService: service, onAuthenticated: () => host.replaceChildren() });
    expect(host.querySelector("form")).toBeNull();

    service.invalidate();
    expect(host.querySelector('input[name="token"]')).toHaveProperty("type", "password");
  });
});
