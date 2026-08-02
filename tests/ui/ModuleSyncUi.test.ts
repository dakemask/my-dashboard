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

import type { SyncCoordinatorSnapshot } from "../../src/shared/sync";
import {
  ModuleSyncUi,
  type ModuleSyncUiRuntime,
} from "../../src/shared/ui";

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute("open");
  };
});

afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("ModuleSyncUi", () => {
  it("keeps local mode limited to local-save status and clears stale failures", () => {
    const mount = createMount();
    const runtime = createRuntime("local", snapshot({ sessionDirty: true }));
    const ui = new ModuleSyncUi({
      mount,
      guardAction: () => ({ status: "ready" }),
    });

    ui.attachRuntime(runtime);
    ui.setLocalSaveFailed(true);
    expect(mount.querySelector(".shared-module-sync")?.getAttribute("data-state")).toBe("local");
    expect(mount.querySelector(".shared-module-sync-state")?.textContent).toBe("本地内容尚未保存");
    expect((mount.querySelector(".shared-module-sync-actions") as HTMLElement).hidden).toBe(true);
    expect((mount.querySelectorAll(".shared-module-sync-versions span")[1] as HTMLElement).hidden).toBe(true);

    ui.renderSnapshot(snapshot({ sessionDirty: false }));
    expect(mount.querySelector(".shared-module-sync-state")?.textContent).toBe("仅保存在本机");
  });

  it("runs the business gate before an action and exposes safe blocked feedback", async () => {
    const mount = createMount();
    const runtime = createRuntime("account", snapshot());
    const guardAction = vi.fn(() => ({
      status: "blocked" as const,
      message: "请先结束当前编辑。",
    }));
    const ui = new ModuleSyncUi({ mount, guardAction });
    ui.attachRuntime(runtime);

    clickAction(mount, "upload");
    await flushPromises();

    expect(guardAction).toHaveBeenCalledWith("upload");
    expect(runtime.upload).not.toHaveBeenCalled();
    const toast = mount.querySelector(".shared-module-sync-toast") as HTMLElement;
    expect(toast.textContent).toBe("请先结束当前编辑。");
    expect(toast.getAttribute("role")).toBe("status");
  });

  it("orders destructive dialog actions safely and restores focus after cancellation", async () => {
    const mount = createMount();
    const runtime = createRuntime("account", snapshot());
    runtime.upload.mockResolvedValue("conflict");
    const ui = new ModuleSyncUi({
      mount,
      guardAction: () => ({ status: "ready" }),
    });
    ui.attachRuntime(runtime);

    const uploadButton = mount.querySelector<HTMLButtonElement>('[data-action="upload"]')!;
    uploadButton.focus();
    uploadButton.click();
    await flushPromises();

    const region = mount.querySelector(".shared-module-sync")!;
    const dialog = mount.querySelector(".shared-module-sync-dialog") as HTMLDialogElement;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    expect(dialog.open).toBe(true);
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(region.querySelector(".shared-module-sync-state")?.textContent).toBe(
      "正在上传…",
    );
    expect(buttons.map((button) => button.textContent)).toEqual([
      "取消",
      "本地覆盖云端",
    ]);
    expect(buttons[0]).toBe(document.activeElement);
    expect(buttons[1]?.dataset.tone).toBe("danger");

    buttons[0]!.click();
    await flushPromises();
    expect(dialog.open).toBe(false);
    expect(runtime.resolveConflict).not.toHaveBeenCalled();
    expect(uploadButton).toBe(document.activeElement);
    expect(region.hasAttribute("aria-busy")).toBe(false);
  });

  it("resolves an upload conflict only after explicit local-wins confirmation", async () => {
    const mount = createMount();
    const runtime = createRuntime("account", snapshot());
    runtime.upload.mockResolvedValue("conflict");
    runtime.resolveConflict.mockResolvedValue("uploaded");
    const ui = new ModuleSyncUi({
      mount,
      guardAction: () => ({ status: "ready" }),
    });
    ui.attachRuntime(runtime);

    clickAction(mount, "upload");
    await flushPromises();
    const confirm = mount.querySelector<HTMLButtonElement>(
      '.shared-module-sync-dialog-button[data-tone="danger"]',
    )!;
    confirm.click();
    await flushPromises();

    expect(runtime.resolveConflict).toHaveBeenCalledWith("local-wins");
    const toast = mount.querySelector(".shared-module-sync-toast") as HTMLElement;
    expect(toast.textContent).toBe("已上传到云端。");
    expect(toast.dataset.tone).toBe("success");
  });

  it("uses an assertive 6200ms toast for transient operation failures", async () => {
    vi.useFakeTimers();
    const mount = createMount();
    const runtime = createRuntime("account", snapshot());
    runtime.upload.mockRejectedValue(new Error("contains unsafe details"));
    const ui = new ModuleSyncUi({
      mount,
      guardAction: () => ({ status: "ready" }),
    });
    ui.attachRuntime(runtime);

    clickAction(mount, "upload");
    await flushPromises();
    const toast = mount.querySelector(".shared-module-sync-toast") as HTMLElement;
    expect(toast.textContent).toBe("上传失败；本机内容仍然保留。");
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.getAttribute("aria-live")).toBe("assertive");
    expect(toast.hidden).toBe(false);

    vi.advanceTimersByTime(6199);
    expect(toast.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(toast.hidden).toBe(true);
  });
});

function snapshot(
  overrides: Partial<SyncCoordinatorSnapshot> = {},
): SyncCoordinatorSnapshot {
  return {
    initialized: true,
    sessionDirty: false,
    localChangedSinceSync: false,
    businessChangedSinceSync: false,
    migrationChangedSinceSync: false,
    localSavedAt: "2026-08-03T02:00:00.000Z",
    knownRemoteRevision: "remote-r1",
    knownRemoteUpdatedAt: "2026-08-03T01:00:00.000Z",
    lastSyncedRemoteRevision: "remote-r1",
    pendingUpload: null,
    conflict: null,
    ...overrides,
  };
}

function createRuntime(
  mode: ModuleSyncUiRuntime["mode"],
  currentSnapshot: SyncCoordinatorSnapshot,
): {
  mode: ModuleSyncUiRuntime["mode"];
  upload: ReturnType<typeof vi.fn<ModuleSyncUiRuntime["upload"]>>;
  pull: ReturnType<typeof vi.fn<ModuleSyncUiRuntime["pull"]>>;
  resolveConflict: ReturnType<typeof vi.fn<ModuleSyncUiRuntime["resolveConflict"]>>;
  getSnapshot: ReturnType<typeof vi.fn<ModuleSyncUiRuntime["getSnapshot"]>>;
} {
  return {
    mode,
    upload: vi.fn<ModuleSyncUiRuntime["upload"]>().mockResolvedValue("uploaded"),
    pull: vi.fn<ModuleSyncUiRuntime["pull"]>().mockResolvedValue("unchanged"),
    resolveConflict: vi.fn<ModuleSyncUiRuntime["resolveConflict"]>().mockResolvedValue("uploaded"),
    getSnapshot: vi.fn<ModuleSyncUiRuntime["getSnapshot"]>(() => currentSnapshot),
  };
}

function createMount(): HTMLElement {
  const mount = document.createElement("div");
  document.body.append(mount);
  return mount;
}

function clickAction(mount: HTMLElement, action: "upload" | "pull"): void {
  mount.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
