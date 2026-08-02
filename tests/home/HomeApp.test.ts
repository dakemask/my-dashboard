// @vitest-environment jsdom

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { HomeApp } from "../../src/home/app/HomeApp";
import type { DashboardProfileStore } from "../../src/shared/profiles";

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(): void {
    if (!this.open) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("HomeApp", () => {
  it("cleans a prepared account profile when registration fails", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const profileStore = createFailingProfileStore();
    const clearAccountProfile = vi.fn().mockResolvedValue(undefined);
    const bindFirstAccount = vi.fn().mockResolvedValue(undefined);
    const app = new HomeApp(root, {
      profileStore,
      authenticate: vi.fn().mockResolvedValue(session),
      inspectFirstAccount: vi.fn().mockResolvedValue({
        localHasData: true,
        cloudHasData: false,
        needsChoice: false,
        suggestedDirection: "local-wins",
      }),
      bindFirstAccount,
      clearAccountProfile,
      clearLocalProfile: vi.fn().mockResolvedValue(undefined),
    });
    app.start();

    root.querySelector<HTMLButtonElement>(".settings-button")!.click();
    root.querySelector<HTMLButtonElement>(".add-account-button")!.click();
    root.querySelector<HTMLInputElement>('input[name="username"]')!.value = "octocat";
    root.querySelector<HTMLInputElement>('input[name="token"]')!.value = "secret-token";
    root.querySelector<HTMLFormElement>("form")!.requestSubmit();
    await flushPromises();

    expect(bindFirstAccount).toHaveBeenCalledWith(
      session,
      "github-octocat",
      "local-wins",
    );
    expect(clearAccountProfile).toHaveBeenCalledWith("github-octocat");
    expect(root.querySelector("dialog")?.dataset.state).toBe("error");
    const errorMessage = root.querySelector('[role="alert"]')?.textContent ?? "";
    expect(errorMessage).toContain("云端可能已经更新了部分模块");
    expect(errorMessage).toContain("不会自动回滚");
    expect(errorMessage).toContain("保持“本地覆盖云端”方向重试");
    expect(errorMessage).not.toContain("secret-token");
  });
});

function createFailingProfileStore(): DashboardProfileStore {
  return {
    getState: () => ({ mode: "local", accounts: [], activeAccountId: null }),
    getActiveContext: () => ({ mode: "local", profileId: "local" }),
    addAccount: vi.fn(() => {
      throw new Error("registration failed with secret-token");
    }),
    selectAccount: vi.fn(() => {
      throw new Error("not used");
    }),
    removeAccount: vi.fn(),
    hasAccounts: () => false,
  };
}

const session = {
  credentials: { username: "octocat", token: "secret-token" },
  repository: {
    owner: "octocat",
    repository: "my-dashboard-data",
    branch: "main",
  },
};

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
