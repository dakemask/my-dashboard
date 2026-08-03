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

import {
  FragmentThoughtsShell,
  renderSafeStartupFailure,
} from "../../src/fragment-thoughts/ui/shell";

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
  vi.useRealTimers();
  document.documentElement.classList.remove("ft-history-modal-open");
  document.body.replaceChildren();
});

describe("FragmentThoughtsShell components", () => {
  it("keeps the composer node stable and forwards semantic page callbacks", () => {
    const shell = createShell();
    const onComposerInput = vi.fn();
    const onComposerSubmit = vi.fn();
    const onComposerClear = vi.fn();
    const onSearchInput = vi.fn();
    const onSearchClear = vi.fn();
    const onRetrySave = vi.fn();
    shell.bindCallbacks({
      onComposerInput,
      onComposerSubmit,
      onComposerClear,
      onSearchInput,
      onSearchClear,
      onRetrySave,
    });

    const composer = shell.elements.composerInput;
    shell.setComposerValue("原生撤销应保留");
    composer.focus();
    composer.setSelectionRange(3, 3);
    shell.setComposerValue("原生撤销应保留");
    expect(shell.elements.composerInput).toBe(composer);
    expect(composer.selectionStart).toBe(3);
    expect(shell.getComposerValue()).toBe("原生撤销应保留");
    expect(shell.hasComposerDraft()).toBe(true);

    composer.value = "新的草稿";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    shell.elements.composerForm.requestSubmit();
    shell.elements.composerClearButton.click();
    expect(onComposerInput).toHaveBeenCalledWith("新的草稿");
    expect(onComposerSubmit).toHaveBeenCalledWith("新的草稿");
    expect(onComposerClear).toHaveBeenCalledOnce();

    shell.elements.searchInput.value = "命中";
    shell.elements.searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    shell.elements.searchClearButton.click();
    expect(onSearchInput).toHaveBeenCalledWith("命中");
    expect(onSearchClear).toHaveBeenCalledOnce();
    expect(shell.getSearchValue()).toBe("命中");

    shell.setSaveFailure("仍未保存");
    shell.elements.retrySaveButton.click();
    expect(onRetrySave).toHaveBeenCalledOnce();
    expect(shell.getSyncMount()).toBe(shell.elements.syncMount);
    expect(shell.elements.homeLink.href).toBe(new URL("/", document.location.href).href);
    shell.dispose();
  });

  it("keeps keyed history focus and reapplies draft/search locks after rendering", () => {
    const shell = createShell();
    const onToggleHistoryVersion = vi.fn();
    shell.bindCallbacks({ onToggleHistoryVersion });
    shell.renderHistory({
      thoughtId: "thought-1",
      versions: [{
        id: "version-1",
        content: "命中正文",
        createdAt: "2026-08-03T00:00:00.000Z",
        highlightQuery: "命中",
      }],
    });

    const originalToggle = shell.elements.historyList.querySelector<HTMLButtonElement>(
      'button[data-action="toggle-history-version"]',
    )!;
    shell.setHistoryCollapseDraftLocked(true);
    originalToggle.focus();
    shell.renderHistory({
      thoughtId: "thought-1",
      versions: [{
        id: "version-1",
        content: "再次命中",
        createdAt: "2026-08-03T00:00:01.000Z",
        highlightQuery: "命中",
      }],
    });
    const keyedToggle = shell.elements.historyList.querySelector<HTMLButtonElement>(
      'button[data-action="toggle-history-version"]',
    )!;
    expect(keyedToggle).toBe(originalToggle);
    expect(document.activeElement).toBe(originalToggle);
    expect(keyedToggle.getAttribute("aria-disabled")).toBe("true");
    expect(keyedToggle.title).toContain("当前草稿");
    keyedToggle.click();
    expect(onToggleHistoryVersion).not.toHaveBeenCalled();
    expect(shell.elements.toast.textContent).toContain("当前草稿");

    shell.setHistoryCollapseDraftLocked(false);
    shell.renderHistory({
      thoughtId: "thought-1",
      versions: [{
        id: "version-1",
        content: "再次命中",
        createdAt: "2026-08-03T00:00:01.000Z",
        collapseLockedMessage: "搜索命中的版本保持展开。",
        highlightQuery: "命中",
      }],
    });
    keyedToggle.click();
    expect(onToggleHistoryVersion).not.toHaveBeenCalled();
    expect(shell.elements.toast.textContent).toBe("搜索命中的版本保持展开。");
    expect(shell.elements.toast.getAttribute("role")).toBe("status");
    expect(shell.elements.historyList.querySelector("mark")?.textContent).toBe("命中");
    shell.dispose();
  });

  it("restores history focus and keeps confirmation actions in safe order", async () => {
    const shell = createShell();
    const trigger = shell.elements.composerInput;
    shell.bindCallbacks({
      onCloseHistory: () => shell.setHistoryOpen(false),
    });
    trigger.focus();
    shell.setHistoryOpen(true);
    shell.focusHistoryClose();
    expect(document.activeElement).toBe(shell.elements.historyCloseButton);
    shell.elements.historyCloseButton.click();
    expect(document.activeElement).toBe(trigger);

    const confirmationTrigger = document.createElement("button");
    confirmationTrigger.textContent = "打开确认";
    shell.elements.root.append(confirmationTrigger);
    confirmationTrigger.focus();
    const choice = shell.choose("确认", "请选择", [
      { id: "delete", label: "删除", tone: "danger" },
      { id: "keep", label: "保留", tone: "primary" },
      { id: "cancel", label: "取消" },
    ]);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(
      ".ft-dialog-actions button",
    )];
    expect(buttons.map(({ textContent }) => textContent)).toEqual([
      "取消",
      "保留",
      "删除",
    ]);
    expect(document.activeElement).toBe(buttons[0]);
    buttons[1]!.click();
    await expect(choice).resolves.toBe("keep");
    expect(document.activeElement).toBe(confirmationTrigger);

    const backdropChoice = shell.choose("再次确认", "不要误关", [
      { id: "cancel", label: "取消" },
      { id: "confirm", label: "确认", tone: "primary" },
    ]);
    const dialog = document.querySelector<HTMLDialogElement>(".ft-dialog")!;
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 300,
      bottom: 300,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    });
    dialog.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 150,
      clientY: 150,
    }));
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 20,
      clientY: 20,
    }));
    await expect(backdropChoice).resolves.toBe("cancel");
    expect(document.activeElement).toBe(confirmationTrigger);
    shell.dispose();
  });

  it("uses status for ordinary toasts and alert for 6200ms errors", () => {
    vi.useFakeTimers();
    const shell = createShell();

    shell.showMessage("已保存", "success");
    expect(shell.elements.toast.getAttribute("role")).toBe("status");
    vi.advanceTimersByTime(4199);
    expect(shell.elements.toast.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shell.elements.toast.hidden).toBe(true);

    shell.showMessage("保存失败", "error");
    expect(shell.elements.toast.getAttribute("role")).toBe("alert");
    expect(shell.elements.toast.getAttribute("aria-live")).toBe("assertive");
    vi.advanceTimersByTime(6199);
    expect(shell.elements.toast.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shell.elements.toast.hidden).toBe(true);
    shell.dispose();
  });

  it("has one safe startup failure renderer", () => {
    const appRoot = document.createElement("div");
    document.body.append(appRoot);
    renderSafeStartupFailure(appRoot);
    expect(appRoot.querySelectorAll(".ft-startup-error")).toHaveLength(1);
    expect(appRoot.textContent).not.toContain("Error");
    expect(appRoot.querySelector("a")?.textContent).toBe("返回首页");
  });
});

function createShell(): FragmentThoughtsShell {
  const appRoot = document.createElement("div");
  appRoot.id = "app";
  document.body.append(appRoot);
  return new FragmentThoughtsShell(appRoot);
}
