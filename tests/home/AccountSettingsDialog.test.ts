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

import type { DashboardProfileState } from "../../src/shared/profiles";
import {
  AccountSettingsDialog,
  type AccountSettingsDialogOptions,
} from "../../src/home/ui";

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

describe("AccountSettingsDialog", () => {
  it("uses one dialog for direction choice and blocks every close path while busy", async () => {
    const busy = deferred<void>();
    let selectedDirection = "";
    const addAccount = vi.fn<AccountSettingsDialogOptions["addAccount"]>(
      async (_credentials, hooks) => {
        selectedDirection = await hooks.chooseFirstAccountDirection();
        hooks.setBusyStage("正在写入全部模块…");
        await busy.promise;
      },
    );
    const fixture = createFixture({ addAccount, replaceTriggerOnChange: true });

    openAddForm(fixture.host);
    fillCredentials(fixture.host, "octocat", "secret-token");
    fixture.host.querySelector<HTMLFormElement>("form")!.requestSubmit();
    await flushPromises();

    const dialog = fixture.host.querySelector<HTMLDialogElement>("dialog")!;
    expect(fixture.host.querySelectorAll("dialog")).toHaveLength(1);
    expect(dialog.dataset.state).toBe("direction-choice");
    const actions = [...dialog.querySelectorAll<HTMLButtonElement>(
      ".first-account-actions button",
    )];
    expect(actions.map((button) => button.textContent)).toEqual([
      "取消",
      "本地覆盖云端",
      "云端覆盖本地",
    ]);
    expect(actions[0]).toBe(document.activeElement);
    expect(actions[2]?.className).toBe("danger-button");

    actions[1]!.click();
    await flushPromises();
    expect(selectedDirection).toBe("local-wins");
    expect(dialog.dataset.state).toBe("busy");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(dialog.querySelector('[role="status"]')?.textContent).toContain(
      "正在写入全部模块",
    );
    expect(dialog.querySelector<HTMLButtonElement>(".icon-button")?.disabled).toBe(true);

    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    dialog.click();
    expect(dialog.open).toBe(true);

    busy.resolve();
    await flushPromises();
    expect(dialog.isConnected).toBe(false);
    expect(fixture.onProfileChanged).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(fixture.getReplacementTrigger());
  });

  it("clears the token after failure and when the user cancels", async () => {
    const addAccount = vi.fn<AccountSettingsDialogOptions["addAccount"]>()
      .mockRejectedValue(new Error("unsafe secret-token detail"));
    const fixture = createFixture({ addAccount });

    openAddForm(fixture.host);
    fillCredentials(fixture.host, "octocat", "secret-token");
    const submittedToken = fixture.host.querySelector<HTMLInputElement>(
      'input[name="token"]',
    )!;
    fixture.host.querySelector<HTMLFormElement>("form")!.requestSubmit();
    await flushPromises();

    const dialog = fixture.host.querySelector<HTMLDialogElement>("dialog")!;
    const retryToken = dialog.querySelector<HTMLInputElement>('input[name="token"]')!;
    expect(dialog.dataset.state).toBe("error");
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe("安全错误文案");
    expect(submittedToken.value).toBe("");
    expect(retryToken.value).toBe("");

    retryToken.value = "second-secret-token";
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(retryToken.value).toBe("");
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(fixture.trigger);
  });

  it("re-renders after account selection and focuses the equivalent new trigger", () => {
    const profile: DashboardProfileState = {
      mode: "accounts",
      activeAccountId: "github-first",
      accounts: [
        { id: "github-first", username: "first" },
        { id: "github-second", username: "second" },
      ],
    };
    const fixture = createFixture({ profile, replaceTriggerOnChange: true });

    const accountButtons = fixture.host.querySelectorAll<HTMLButtonElement>(
      ".account-option",
    );
    accountButtons[1]!.click();

    expect(fixture.selectAccount).toHaveBeenCalledWith("github-second");
    expect(fixture.onProfileChanged).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(fixture.getReplacementTrigger());
  });

  it("clears form tokens when returning to the overview", () => {
    const fixture = createFixture();
    openAddForm(fixture.host);
    const token = fixture.host.querySelector<HTMLInputElement>('input[name="token"]')!;
    token.value = "secret-token";

    fixture.host.querySelector<HTMLButtonElement>(".secondary-button")!.click();

    expect(token.value).toBe("");
    expect(fixture.host.querySelector("dialog")?.getAttribute("data-state")).toBe(
      "overview",
    );
  });
});

interface FixtureOptions {
  readonly profile?: DashboardProfileState;
  readonly addAccount?: AccountSettingsDialogOptions["addAccount"];
  readonly replaceTriggerOnChange?: boolean;
}

function createFixture(options: FixtureOptions = {}) {
  const host = document.createElement("main");
  const trigger = createSettingsTrigger();
  host.append(trigger);
  document.body.append(host);
  trigger.focus();

  const selectAccount = vi.fn();
  let replacementTrigger: HTMLButtonElement | null = null;
  const onProfileChanged = vi.fn(() => {
    if (!options.replaceTriggerOnChange) return null;
    replacementTrigger = createSettingsTrigger();
    trigger.replaceWith(replacementTrigger);
    return replacementTrigger;
  });
  const dialog = new AccountSettingsDialog({
    document,
    host,
    getProfileState: () => options.profile ?? localProfile,
    selectAccount,
    addAccount: options.addAccount ?? vi.fn().mockResolvedValue(undefined),
    describeError: () => "安全错误文案",
    onProfileChanged,
  });
  dialog.open(trigger);
  return {
    host,
    trigger,
    selectAccount,
    onProfileChanged,
    getReplacementTrigger: () => replacementTrigger,
  };
}

function createSettingsTrigger(): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "settings-button";
  trigger.textContent = "账户设置";
  return trigger;
}

function openAddForm(host: HTMLElement): void {
  host.querySelector<HTMLButtonElement>(".add-account-button")!.click();
}

function fillCredentials(host: HTMLElement, username: string, token: string): void {
  host.querySelector<HTMLInputElement>('input[name="username"]')!.value = username;
  host.querySelector<HTMLInputElement>('input[name="token"]')!.value = token;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const localProfile: DashboardProfileState = {
  mode: "local",
  accounts: [],
  activeAccountId: null,
};
