// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LibraryTreeView,
  type LibraryDraft,
  type LibrarySelection,
  type LibraryTreeCallbacks,
  type LibraryTreeRenderState,
} from "../../src/mind-map/library/treeView";
import type { MindMapPayload } from "../../src/mind-map/domain";

const payload: MindMapPayload = {
  folders: ["工作", "工作/项目", "资料"],
  maps: [
    { id: "map-root", path: "随手记", nodes: [], arrows: [] },
    { id: "map-project", path: "工作/项目/路线图", nodes: [], arrows: [] },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("LibraryTreeView selection", () => {
  it("selects a folder and toggles its expansion with the same click", () => {
    const fixture = createFixture();
    fixture.view.render(createState());

    rowNamed(fixture.container, "工作").click();

    expect(fixture.callbacks.onSelect).toHaveBeenCalledWith({ kind: "folder", path: "工作" });
    expect(fixture.callbacks.onToggleFolder).toHaveBeenCalledWith("工作", true);
  });

  it("selects and opens a map with the same click", () => {
    const fixture = createFixture();
    fixture.view.render(createState());

    rowNamed(fixture.container, "随手记").click();

    expect(fixture.callbacks.onSelect).toHaveBeenCalledWith({ kind: "map", mapId: "map-root" });
    expect(fixture.callbacks.onOpenMap).toHaveBeenCalledWith("map-root");
  });

  it("exposes selected and current tree items to assistive technology", () => {
    const fixture = createFixture();
    fixture.view.render(createState({
      selection: { kind: "map", mapId: "map-root" },
      currentMapId: "map-root",
    }));

    const item = rowNamed(fixture.container, "随手记").closest<HTMLElement>("[role=treeitem]")!;
    expect(item.getAttribute("aria-selected")).toBe("true");
    expect(item.getAttribute("aria-current")).toBe("page");
  });
});

describe("LibraryTreeView inline drafts", () => {
  it("commits a new item with Enter", async () => {
    const fixture = createFixture();
    fixture.view.render(createState());
    fixture.view.beginCreate("folder", "");
    const input = draftInput(fixture.container);
    input.value = "新文件夹";

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(fixture.callbacks.commitDraft).toHaveBeenCalledWith(
      { kind: "new-folder", parentPath: "" },
      "新文件夹",
    );
    expect(fixture.view.draft).toBeNull();
    expect(fixture.container.querySelector(".library-inline-editor")).toBeNull();
  });

  it("does not submit Enter while a Chinese IME composition is active", () => {
    const fixture = createFixture();
    fixture.view.render(createState());
    fixture.view.beginCreate("folder", "");
    const input = draftInput(fixture.container);
    input.value = "中文名称";

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }));

    expect(fixture.callbacks.commitDraft).not.toHaveBeenCalled();
    expect(fixture.view.draft).toEqual({ kind: "new-folder", parentPath: "" });
    expect(input.value).toBe("中文名称");
  });

  it("commits a rename on blur and starts with the current display name", () => {
    const fixture = createFixture();
    fixture.view.render(createState({ expandedFolders: new Set(["工作", "工作/项目"]) }));
    fixture.view.beginRename({ kind: "map", mapId: "map-project" });
    const input = draftInput(fixture.container);

    expect(input.value).toBe("路线图");
    input.value = "产品路线";
    input.dispatchEvent(new FocusEvent("blur"));

    expect(fixture.callbacks.commitDraft).toHaveBeenCalledWith(
      { kind: "rename", selection: { kind: "map", mapId: "map-project" } },
      "产品路线",
    );
    expect(fixture.view.draft).toBeNull();
  });

  it("has an explicit cancel button which discards the draft", () => {
    const fixture = createFixture();
    fixture.view.render(createState());
    fixture.view.beginCreate("map", "");

    fixture.container.querySelector<HTMLButtonElement>(".inline-cancel")!.click();

    expect(fixture.callbacks.commitDraft).not.toHaveBeenCalled();
    expect(fixture.callbacks.onDraftCancelled).toHaveBeenCalledOnce();
    expect(fixture.view.draft).toBeNull();
  });

  it("renders a visible accessible IconPark cancel control without using Escape as cancel", () => {
    const fixture = createFixture();
    fixture.view.render(createState());
    fixture.view.beginCreate("map", "");
    const input = draftInput(fixture.container);
    input.value = "保留草稿";
    const cancel = fixture.container.querySelector<HTMLButtonElement>(".inline-cancel")!;

    expect(cancel.hidden).toBe(false);
    expect(cancel.title).toBe("取消新建项目");
    expect(cancel.getAttribute("aria-label")).toBe(cancel.title);
    expect(cancel.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(false);
    expect(fixture.view.draft).toEqual({ kind: "new-map", parentPath: "" });
    expect(input.value).toBe("保留草稿");
    expect(fixture.callbacks.commitDraft).not.toHaveBeenCalled();
    expect(fixture.callbacks.onDraftCancelled).not.toHaveBeenCalled();
  });

  it("uses the same fixed row chrome and keeps keyed read rows across projections", () => {
    const fixture = createFixture();
    fixture.view.render(createState());
    const initial = rowNamed(fixture.container, "随手记");
    expect(initial.classList.contains("library-row-chrome")).toBe(true);

    fixture.view.render(createState({
      selection: { kind: "map", mapId: "map-root" },
      currentMapId: "map-root",
      dirtyMapIds: new Set(["map-root"]),
    }));
    expect(rowNamed(fixture.container, "随手记")).toBe(initial);

    fixture.view.beginRename({ kind: "map", mapId: "map-root" });
    const editor = fixture.container.querySelector<HTMLElement>(".library-inline-editor")!;
    expect(editor.classList.contains("library-row-chrome")).toBe(true);
    expect(editor.querySelector(".folder-arrow")).toBeTruthy();
    expect(editor.querySelector(".library-item-icon")).toBeTruthy();
    expect(editor.querySelector(".library-name-slot input")).toBeTruthy();
  });

  it("keeps an invalid draft visible, reports the error, and does not commit it", async () => {
    const fixture = createFixture({
      validateDraft: vi.fn((_draft, value) => value.trim() ? null : "名称不能为空"),
    });
    fixture.view.render(createState());
    fixture.view.beginCreate("map", "");
    const input = draftInput(fixture.container);
    input.value = "   ";

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(fixture.view.draft).toEqual({ kind: "new-map", parentPath: "" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(fixture.container.querySelector("[role=alert]")?.textContent).toBe("名称不能为空");
    expect(fixture.callbacks.commitDraft).not.toHaveBeenCalled();
  });

  it("settles a valid draft through the normal commit callback", () => {
    const fixture = createFixture();
    fixture.view.render(createState({ expandedFolders: new Set(["资料"]) }));
    fixture.view.beginCreate("folder", "资料");
    draftInput(fixture.container).value = "参考";

    expect(fixture.view.settleDraft(false)).toBe(true);
    expect(fixture.callbacks.commitDraft).toHaveBeenCalledWith(
      { kind: "new-folder", parentPath: "资料" },
      "参考",
    );
    expect(fixture.view.draft).toBeNull();
  });

  it("retains an invalid draft for an ordinary settle and cancels it for a forced settle", () => {
    const fixture = createFixture({
      validateDraft: vi.fn(() => "名称已存在"),
    });
    fixture.view.render(createState());
    fixture.view.beginRename({ kind: "folder", path: "资料" });
    const input = draftInput(fixture.container);
    input.value = "工作";

    expect(fixture.view.settleDraft(false)).toBe(false);
    expect(fixture.view.draft).not.toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(fixture.view.settleDraft(true)).toBe(true);
    expect(fixture.view.draft).toBeNull();
    expect(fixture.callbacks.commitDraft).not.toHaveBeenCalled();
    expect(fixture.callbacks.onDraftCancelled).toHaveBeenCalledOnce();
  });

  it("hands a valid draft to the Shared settle hook without dispatching it itself", () => {
    const fixture = createFixture();
    fixture.view.render(createState({ expandedFolders: new Set(["工作"]) }));
    fixture.view.beginCreate("map", "工作");
    draftInput(fixture.container).value = "周报";

    expect(fixture.view.takeDraftForSettle(true)).toEqual({
      draft: { kind: "new-map", parentPath: "工作" },
      value: "周报",
    });
    expect(fixture.callbacks.commitDraft).not.toHaveBeenCalled();
    expect(fixture.view.draft).toBeNull();
  });
});

describe("LibraryTreeView drag and drop", () => {
  it("moves a map into an existing folder", () => {
    const fixture = createFixture();
    fixture.view.render(createState());
    const dragged = rowNamed(fixture.container, "随手记");
    const destination = rowNamed(fixture.container, "资料");

    dispatchDrag(dragged, "dragstart");
    dispatchDrag(destination, "dragover");
    dispatchDrag(destination, "drop");

    expect(fixture.callbacks.onMove).toHaveBeenCalledWith(
      { kind: "map", mapId: "map-root" },
      "资料",
    );
    expect(destination.classList.contains("drop-target")).toBe(false);
  });

  it("moves a nested item to the root drop target", () => {
    const fixture = createFixture();
    fixture.view.render(createState({ expandedFolders: new Set(["工作", "工作/项目"]) }));
    const dragged = rowNamed(fixture.container, "路线图");

    dispatchDrag(dragged, "dragstart");
    dispatchDrag(fixture.rootDropTarget, "dragover");
    dispatchDrag(fixture.rootDropTarget, "drop");

    expect(fixture.callbacks.onMove).toHaveBeenCalledWith(
      { kind: "map", mapId: "map-project" },
      "",
    );
    expect(fixture.rootDropTarget.classList.contains("drop-target")).toBe(false);
  });

  it("expands a collapsed folder after a 650ms drag hover", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.view.render(createState());
    const dragged = rowNamed(fixture.container, "随手记");
    const destination = rowNamed(fixture.container, "工作");

    dispatchDrag(dragged, "dragstart");
    dispatchDrag(destination, "dragover");
    vi.advanceTimersByTime(649);
    expect(fixture.callbacks.onToggleFolder).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(fixture.callbacks.onToggleFolder).toHaveBeenCalledWith("工作", true);
  });

  it("expands a hovered folder without replacing the native drag source", () => {
    const fixture = createFixture();
    fixture.view.render(createState());
    const dragged = rowNamed(fixture.container, "随手记");
    const destination = rowNamed(fixture.container, "工作");

    dispatchDrag(dragged, "dragstart");
    expect(fixture.view.expandFolderDuringDrag("工作")).toBe(true);

    expect(fixture.view.dragging).toBe(true);
    expect(dragged.isConnected).toBe(true);
    expect(rowNamed(fixture.container, "项目")).toBeTruthy();
    dispatchDrag(destination, "drop");
    expect(fixture.callbacks.onMove).toHaveBeenCalledWith(
      { kind: "map", mapId: "map-root" },
      "工作",
    );
  });

  it("does not schedule a second expansion after a hovered target is already open", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.view.render(createState());
    const dragged = rowNamed(fixture.container, "随手记");
    const destination = rowNamed(fixture.container, "工作");

    dispatchDrag(dragged, "dragstart");
    dispatchDrag(destination, "dragover");
    vi.advanceTimersByTime(650);
    expect(fixture.callbacks.onToggleFolder).toHaveBeenCalledTimes(1);
    expect(fixture.view.expandFolderDuringDrag("工作")).toBe(true);

    dispatchDrag(destination, "dragover");
    vi.advanceTimersByTime(700);

    expect(fixture.callbacks.onToggleFolder).toHaveBeenCalledTimes(1);
    expect(dragged.isConnected).toBe(true);
  });

  it("cancels drag state and delayed auto-expansion during settle", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.view.render(createState());
    const dragged = rowNamed(fixture.container, "随手记");
    const destination = rowNamed(fixture.container, "工作");

    dispatchDrag(dragged, "dragstart");
    dispatchDrag(destination, "dragover");
    fixture.view.cancelLiveInteraction();
    vi.advanceTimersByTime(700);

    expect(fixture.view.dragging).toBe(false);
    expect(fixture.callbacks.onToggleFolder).not.toHaveBeenCalled();
    expect(destination.classList.contains("drop-target")).toBe(false);
  });

  it("does not start a move from a synthetic drop without a preceding dragstart", () => {
    const fixture = createFixture();
    fixture.view.render(createState());

    dispatchDrag(rowNamed(fixture.container, "资料"), "drop");
    dispatchDrag(fixture.rootDropTarget, "drop");

    expect(fixture.callbacks.onMove).not.toHaveBeenCalled();
  });

  it("removes delegated drag listeners and pending hover work on dispose", () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    fixture.view.render(createState());
    const dragged = rowNamed(fixture.container, "随手记");
    const destination = rowNamed(fixture.container, "工作");

    dispatchDrag(dragged, "dragstart");
    dispatchDrag(destination, "dragover");
    fixture.view.dispose();
    vi.advanceTimersByTime(700);
    dispatchDrag(destination, "drop");

    expect(fixture.view.dragging).toBe(false);
    expect(fixture.callbacks.onToggleFolder).not.toHaveBeenCalled();
    expect(fixture.callbacks.onMove).not.toHaveBeenCalled();
  });
});

function createFixture(
  overrides: Partial<LibraryTreeCallbacks> = {},
): {
  container: HTMLElement;
  rootDropTarget: HTMLElement;
  callbacks: LibraryTreeCallbacks & Record<string, ReturnType<typeof vi.fn>>;
  view: LibraryTreeView;
} {
  const container = document.createElement("div");
  const rootDropTarget = document.createElement("button");
  document.body.append(container, rootDropTarget);
  const callbacks = {
    onSelect: vi.fn<(selection: LibrarySelection) => void>(),
    onOpenMap: vi.fn<(mapId: string) => void>(),
    onToggleFolder: vi.fn<(path: string, expanded: boolean) => void>(),
    onMove: vi.fn<(selection: Exclude<LibrarySelection, null>, destinationFolder: string) => void>(),
    validateDraft: vi.fn<(_draft: LibraryDraft, _value: string) => string | null>(() => null),
    commitDraft: vi.fn<(_draft: LibraryDraft, _value: string) => string | null>(() => null),
    onDraftCancelled: vi.fn<() => void>(),
    ...overrides,
  } as LibraryTreeCallbacks & Record<string, ReturnType<typeof vi.fn>>;
  return {
    container,
    rootDropTarget,
    callbacks,
    view: new LibraryTreeView(container, rootDropTarget, callbacks),
  };
}

function createState(overrides: Partial<LibraryTreeRenderState> = {}): LibraryTreeRenderState {
  return {
    payload,
    selection: null,
    currentMapId: null,
    expandedFolders: new Set(),
    dirtyMapIds: new Set(),
    dirtyFolderPaths: new Set(),
    ...overrides,
  };
}

function rowNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const row = [...container.querySelectorAll<HTMLButtonElement>(".library-row")]
    .find((candidate) => candidate.querySelector(".library-item-name")?.textContent === name);
  if (!row) throw new Error(`Missing library row: ${name}`);
  return row;
}

function draftInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(".library-inline-editor input");
  if (!input) throw new Error("Missing inline draft input.");
  return input;
}

function dispatchDrag(target: EventTarget, type: string): Event {
  const dataTransfer = {
    dropEffect: "none",
    effectAllowed: "none",
    setData: vi.fn(),
  };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
}
