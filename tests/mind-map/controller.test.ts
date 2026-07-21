// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModuleRuntime,
  ModuleRuntimeHooks,
  ModuleRuntimeSnapshot,
  SyncActionResult,
} from "../../src/shared";
import { MindMapController } from "../../src/mind-map/app/controller";
import {
  applyMindMapEvent,
  type MindMapEvent,
  type MindMapPayload,
} from "../../src/mind-map/domain";

const payload: MindMapPayload = {
  folders: ["工作"],
  maps: [
    {
      id: "map-one",
      path: "工作/项目一",
      nodes: [
        {
          id: "node-one",
          text: "第一个节点",
          x: 20,
          y: 30,
          width: 180,
          height: 72,
          autoWidth: false,
        },
      ],
      arrows: [],
    },
    {
      id: "map-two",
      path: "第二张",
      nodes: [
        {
          id: "node-two",
          text: "第二个节点",
          x: 80,
          y: 100,
          width: 180,
          height: 72,
          autoWidth: false,
        },
      ],
      arrows: [],
    },
  ],
};

const controllers: MindMapController[] = [];

beforeEach(() => {
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (value: string) => ({ width: value.length * 8 }),
    }),
  });
  Object.defineProperty(window.HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(window.HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const controller of controllers.splice(0)) await controller.dispose();
  document.body.replaceChildren();
});

describe("MindMapController initialization and selection ownership", () => {
  it("restores the local sidebar/map preference and keeps library and canvas selection exclusive", () => {
    const storage = new MemoryStorage();
    storage.setItem("my-dashboard.mind-maps.sidebar-open", "false");
    storage.setItem("my-dashboard.mind-maps.last-map-id", "map-one");
    storage.setItem("my-dashboard.mind-maps.expanded-folders", JSON.stringify(["工作"]));
    const { controller } = createFixture({ storage });

    expect(controller.shell.elements.sidebar.hidden).toBe(true);
    expect(controller.shell.elements.sidebarButton.getAttribute("aria-pressed")).toBe("false");
    expect(controller.shell.elements.mapTitle.textContent).toBe("项目一");
    expect(rowNamed(controller, "项目一").classList).toContain("current");

    controller.shell.elements.sidebarButton.click();
    expect(controller.shell.elements.sidebar.hidden).toBe(false);
    expect(storage.getItem("my-dashboard.mind-maps.sidebar-open")).toBe("true");

    controller.canvas.setSelection({ nodeIds: ["node-one"], arrowIds: [] });
    rowNamed(controller, "工作").click();
    expect(controller.canvas.getSelection()).toEqual({ nodeIds: [], arrowIds: [] });
    expect(rowNamed(controller, "工作").classList).toContain("selected");

    controller.canvas.setSelection({ nodeIds: ["node-one"], arrowIds: [] });
    expect(rowNamed(controller, "工作").classList).not.toContain("selected");
    expect(controller.canvas.getSelection().nodeIds).toEqual(["node-one"]);
  });

  it("auto-expands a drop target without replacing the active drag source", () => {
    vi.useFakeTimers();
    const { controller, runtime } = createFixture();
    const dragged = rowNamed(controller, "第二张");
    const destination = rowNamed(controller, "工作");

    dispatchDrag(dragged, "dragstart");
    dispatchDrag(destination, "dragover");
    vi.advanceTimersByTime(650);

    expect(dragged.isConnected).toBe(true);
    expect(rowNamed(controller, "项目一")).toBeTruthy();
    dispatchDrag(destination, "dragover");
    vi.advanceTimersByTime(700);
    expect(dragged.isConnected).toBe(true);
    dispatchDrag(destination, "drop");
    expect(runtime.dispatched.at(-1)).toMatchObject({
      type: "relocate-map",
      mapId: "map-two",
      path: "工作/第二张",
    });
  });
});

describe("MindMapController commands", () => {
  it("routes toolbar actions to the runtime and canvas", async () => {
    const { controller, runtime } = createFixture({ openMapId: "map-one" });
    const reset = vi.spyOn(controller.canvas, "resetViewport");

    controller.shell.elements.saveButton.click();
    await flushPromises();
    controller.shell.elements.uploadButton.click();
    await flushPromises();
    runtime.setSnapshot({ sessionDirty: false, localChangedSinceSync: false });
    controller.shell.elements.pullButton.click();
    await flushPromises();

    expect(runtime.saveCalls).toBe(1);
    expect(runtime.uploadCalls).toBe(1);
    expect(runtime.pullCalls).toBe(1);

    controller.shell.elements.addNodeButton.click();
    expect(runtime.dispatched.at(-1)?.type).toBe("add-node");

    controller.shell.elements.addArrowButton.click();
    expect(controller.canvas.arrowMode).toBe(true);
    expect(controller.shell.elements.addArrowButton.getAttribute("aria-pressed")).toBe("true");
    controller.shell.elements.addArrowButton.click();
    expect(controller.canvas.arrowMode).toBe(false);
    expect(controller.shell.elements.addArrowButton.getAttribute("aria-pressed")).toBe("false");

    controller.shell.elements.resetViewButton.click();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("asks for a direction immediately when upload or pull discovers a conflict", async () => {
    const { controller, runtime } = createFixture({ openMapId: "map-one" });
    runtime.uploadResult = "conflict";
    controller.shell.elements.uploadButton.click();
    await flushPromises();
    expect(dialogTitle()).toBe("用本地版本覆盖云端？");
    clickDialogChoice("本地覆盖云端");
    await flushPromises();
    expect(runtime.resolveCalls).toEqual(["local-wins"]);

    runtime.pullResult = "conflict";
    controller.shell.elements.pullButton.click();
    await flushPromises();
    expect(dialogTitle()).toBe("用云端版本覆盖本地？");
    clickDialogChoice("云端覆盖本地");
    await flushPromises();
    expect(runtime.resolveCalls).toEqual(["local-wins", "cloud-wins"]);
  });

  it("does not report success if local-wins encounters another same-module race", async () => {
    const { controller, runtime } = createFixture({ openMapId: "map-one" });
    runtime.uploadResult = "conflict";
    runtime.resolveResult = "conflict";

    controller.shell.elements.uploadButton.click();
    await flushPromises();
    clickDialogChoice("本地覆盖云端");
    await flushPromises();

    expect(controller.shell.elements.toast.textContent).toContain("云端再次变化");
    expect(controller.shell.elements.toast.textContent).not.toContain("已上传到云端");
  });

  it("clears library selection when Alt+1 or Alt+2 enters a canvas command", () => {
    const { controller } = createFixture({ openMapId: "map-one" });
    rowNamed(controller, "工作").click();
    expect(rowNamed(controller, "工作").classList).toContain("selected");

    key(document.body, "2", { altKey: true });

    expect(rowNamed(controller, "工作").classList).not.toContain("selected");
    expect(controller.canvas.arrowMode).toBe(true);
  });

  it("implements exact shortcuts without taking over unrelated keys", async () => {
    const { controller, runtime } = createFixture({ openMapId: "map-one" });
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    const undo = key(input, "z", { ctrlKey: true });
    const redo = key(input, "y", { ctrlKey: true });
    const save = key(input, "s", { ctrlKey: true });
    await flushPromises();
    expect(undo.defaultPrevented).toBe(true);
    expect(redo.defaultPrevented).toBe(true);
    expect(save.defaultPrevented).toBe(true);
    expect(runtime.undoCalls).toBe(1);
    expect(runtime.redoCalls).toBe(1);
    expect(runtime.saveCalls).toBe(1);

    const blockedRedoAlias = key(input, "z", { ctrlKey: true, shiftKey: true });
    await flushPromises();
    expect(blockedRedoAlias.defaultPrevented).toBe(true);
    expect(runtime.undoCalls).toBe(1);
    expect(runtime.redoCalls).toBe(1);

    const eventCount = runtime.dispatched.length;
    const addText = key(input, "1", { altKey: true });
    expect(addText.defaultPrevented).toBe(true);
    expect(runtime.dispatched.slice(eventCount).some((event) => event.type === "add-node")).toBe(true);

    const addArrow = key(input, "2", { altKey: true });
    expect(addArrow.defaultPrevented).toBe(true);
    expect(controller.canvas.arrowMode).toBe(true);

    const callsBeforeBackspace = commandCallCount(runtime);
    const backspace = key(input, "Backspace");
    await flushPromises();
    expect(backspace.defaultPrevented).toBe(false);
    expect(commandCallCount(runtime)).toBe(callsBeforeBackspace);
  });

  it("reveals and focuses a nested folder restored by history", async () => {
    const { controller, runtime } = createFixture({ openMapId: "map-one" });
    runtime.dispatch({ type: "create-folder", path: "工作/新层" });
    rowNamed(controller, "工作").click();
    expect(() => rowNamed(controller, "新层")).toThrow();

    key(document.body, "z", { ctrlKey: true });
    await flushPromises();
    key(document.body, "y", { ctrlKey: true });
    await flushPromises();

    const restored = rowNamed(controller, "新层");
    expect(restored.classList).toContain("selected");
    expect(document.activeElement).toBe(restored);
  });

  it("keeps Delete native in text, opens library confirmation from library focus, and otherwise deletes canvas selection", async () => {
    const { controller, runtime } = createFixture({ openMapId: "map-one" });
    controller.canvas.setSelection({ nodeIds: ["node-one"], arrowIds: [] });
    const input = document.createElement("input");
    document.body.append(input);
    const beforeTextDelete = runtime.dispatched.length;

    const textDelete = key(input, "Delete");
    expect(textDelete.defaultPrevented).toBe(false);
    expect(runtime.dispatched).toHaveLength(beforeTextDelete);
    expect(controller.canvas.getSelection().nodeIds).toEqual(["node-one"]);

    rowNamed(controller, "工作").click();
    await flushPromises();
    const selectedFolder = rowNamed(controller, "工作");
    expect(document.activeElement).toBe(selectedFolder);
    const libraryDelete = key(document.activeElement!, "Delete");
    expect(libraryDelete.defaultPrevented).toBe(true);
    expect(dialogTitle()).toBe("删除文件夹");
    clickDialogChoice("取消");
    await flushPromises();
    expect(runtime.dispatched).toHaveLength(beforeTextDelete);

    controller.canvas.setSelection({ nodeIds: ["node-one"], arrowIds: [] });
    const canvasDelete = key(controller.canvas.element, "Delete");
    expect(canvasDelete.defaultPrevented).toBe(true);
    expect(runtime.dispatched.at(-1)).toMatchObject({
      type: "delete-objects",
      mapId: "map-one",
      nodeIds: ["node-one"],
    });
  });
});

describe("MindMapController status and navigation safety", () => {
  it("preserves live canvas text and library name drafts across metadata-only snapshots", async () => {
    const { controller, runtime } = createFixture({ openMapId: "map-one" });
    controller.canvas.editNode("node-one");
    await flushPromises();
    const textarea = controller.canvas.element.querySelector<HTMLTextAreaElement>(
      'textarea[data-node-id="node-one"]',
    )!;
    textarea.value = "正在使用中文输入\n尚未提交";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中" }));

    runtime.setSnapshot({
      knownRemoteRevision: "remote-metadata",
      knownRemoteUpdatedAt: "2026-07-13T11:00:00.000Z",
    });

    expect(controller.canvas.element.querySelector('textarea[data-node-id="node-one"]')).toBe(textarea);
    expect(textarea.value).toBe("正在使用中文输入\n尚未提交");
    expect(controller.canvas.hasPendingTextChange()).toBe(true);

    controller.canvas.commitActiveTextEdit();
    controller.shell.elements.newFolderButton.click();
    const draft = controller.shell.elements.tree.querySelector<HTMLInputElement>(".library-inline-editor input")!;
    draft.value = "资料库中文草稿";
    runtime.setSnapshot({ knownRemoteUpdatedAt: "2026-07-13T11:01:00.000Z" });

    expect(controller.shell.elements.tree.querySelector(".library-inline-editor input")).toBe(draft);
    expect(draft.value).toBe("资料库中文草稿");
  });

  it("projects version timestamps and exposes conflict state for styling", () => {
    const { controller, runtime } = createFixture({ openMapId: "map-one" });
    const snapshot: ModuleRuntimeSnapshot = {
      ...runtime.getSnapshot(),
      localSavedAt: "2026-07-12T08:09:10.000Z",
      knownRemoteRevision: "remote-8",
      knownRemoteUpdatedAt: "2026-07-13T10:11:12.000Z",
      conflict: {
        observedRemoteRevision: "remote-8",
        observedRemoteUpdatedAt: "2026-07-13T10:11:12.000Z",
        detectedAt: "2026-07-13T10:12:00.000Z",
      },
    };

    controller.hooks.onSnapshotChange?.(snapshot);

    expect(controller.shell.elements.localVersion.title).toBe("2026-07-12T08:09:10.000Z");
    expect(controller.shell.elements.cloudVersion.title).toBe("2026-07-13T10:11:12.000Z");
    expect(controller.shell.elements.versionStatus.dataset.state).toBe("conflict");
    expect(controller.shell.elements.versionStatus.title).toContain("发生冲突");
  });

  it("warns before unload only for changes not saved locally", () => {
    const { controller, runtime } = createFixture({
      openMapId: "map-one",
      snapshot: { localChangedSinceSync: true, sessionDirty: false },
    });

    const savedButNotUploaded = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedButNotUploaded);
    expect(savedButNotUploaded.defaultPrevented).toBe(false);

    runtime.setDirty(true);
    const unsaved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unsaved);
    expect(unsaved.defaultPrevented).toBe(true);

    runtime.setDirty(false);
    controller.shell.elements.newFolderButton.click();
    const invalidBlankDraft = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(invalidBlankDraft);
    expect(invalidBlankDraft.defaultPrevented).toBe(false);

    controller.shell.elements.tree.querySelector<HTMLInputElement>(".library-inline-editor input")!.value = "有效草稿";
    const validDraft = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(validDraft);
    expect(validDraft.defaultPrevented).toBe(true);
  });

  it("asks how to handle unsaved work when returning home, supports cancel, and saves before navigating", async () => {
    const navigateHome = vi.fn();
    const { controller, runtime } = createFixture({ openMapId: "map-one", navigateHome });
    runtime.setDirty(true);

    controller.shell.elements.homeButton.click();
    expect(dialogTitle()).toBe("返回首页");
    clickDialogChoice("取消");
    await flushPromises();
    expect(navigateHome).not.toHaveBeenCalled();

    controller.shell.elements.homeButton.click();
    clickDialogChoice("保存并返回");
    await flushPromises();
    expect(runtime.saveCalls).toBe(1);
    expect(navigateHome).toHaveBeenCalledOnce();

    runtime.setSnapshot({ localChangedSinceSync: true, sessionDirty: false });
    controller.shell.elements.homeButton.click();
    await flushPromises();
    expect(navigateHome).toHaveBeenCalledTimes(2);
  });
});

interface FixtureOptions {
  readonly storage?: Storage;
  readonly openMapId?: string;
  readonly navigateHome?: () => void;
  readonly snapshot?: Partial<ModuleRuntimeSnapshot>;
}

function createFixture(options: FixtureOptions = {}): {
  controller: MindMapController;
  runtime: FakeMindMapRuntime;
} {
  const root = document.createElement("div");
  document.body.append(root);
  const storage = options.storage ?? new MemoryStorage();
  if (options.openMapId) {
    storage.setItem("my-dashboard.mind-maps.last-map-id", options.openMapId);
    storage.setItem("my-dashboard.mind-maps.expanded-folders", JSON.stringify(["工作"]));
  }
  let id = 0;
  const controller = new MindMapController(root, {
    storage,
    createId: () => `generated-${++id}`,
    navigateHome: options.navigateHome ?? vi.fn(),
  });
  const runtime = new FakeMindMapRuntime(payload, controller.hooks, options.snapshot);
  controller.attachRuntime(runtime, payload);
  controllers.push(controller);
  return { controller, runtime };
}

class FakeMindMapRuntime implements ModuleRuntime<MindMapPayload, MindMapEvent> {
  readonly state = "ready" as const;
  readonly dispatched: MindMapEvent[] = [];
  undoCalls = 0;
  redoCalls = 0;
  saveCalls = 0;
  uploadCalls = 0;
  pullCalls = 0;
  resolveCalls: Array<"local-wins" | "cloud-wins"> = [];
  pollCalls = 0;
  disposeCalls = 0;
  uploadResult: SyncActionResult = "uploaded";
  pullResult: SyncActionResult = "unchanged";
  resolveResult: SyncActionResult | null = null;

  readonly #hooks: ModuleRuntimeHooks<MindMapPayload, MindMapEvent>;
  #history: MindMapPayload[];
  #historyIndex = 0;
  #snapshot: ModuleRuntimeSnapshot;
  #dirty = false;

  constructor(
    initial: MindMapPayload,
    hooks: ModuleRuntimeHooks<MindMapPayload, MindMapEvent>,
    snapshot: Partial<ModuleRuntimeSnapshot> = {},
  ) {
    this.#hooks = hooks;
    this.#history = [initial];
    this.#snapshot = {
      initialized: true,
      sessionDirty: false,
      localChangedSinceSync: false,
      localSavedAt: null,
      knownRemoteRevision: null,
      knownRemoteUpdatedAt: null,
      lastSyncedRemoteRevision: null,
      pendingUpload: null,
      conflict: null,
      ...snapshot,
    };
    this.#dirty = this.#snapshot.sessionDirty;
  }

  get current(): MindMapPayload {
    return this.#history[this.#historyIndex]!;
  }

  get canUndo(): boolean {
    return this.#historyIndex > 0;
  }

  get canRedo(): boolean {
    return this.#historyIndex + 1 < this.#history.length;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  dispatch(event: MindMapEvent): MindMapPayload {
    const next = applyMindMapEvent(this.current, event);
    this.dispatched.push(event);
    this.#history = [...this.#history.slice(0, this.#historyIndex + 1), next];
    this.#historyIndex += 1;
    this.#dirty = true;
    this.#snapshot = { ...this.#snapshot, sessionDirty: true };
    this.#hooks.onSnapshotChange?.(this.#snapshot);
    return next;
  }

  async undo(): Promise<MindMapPayload> {
    this.undoCalls += 1;
    if (this.canUndo) this.#historyIndex -= 1;
    this.#hooks.project(this.current, "undo");
    return this.current;
  }

  async redo(): Promise<MindMapPayload> {
    this.redoCalls += 1;
    if (this.canRedo) this.#historyIndex += 1;
    this.#hooks.project(this.current, "redo");
    return this.current;
  }

  async save(): Promise<SyncActionResult> {
    this.saveCalls += 1;
    this.#dirty = false;
    this.#snapshot = {
      ...this.#snapshot,
      sessionDirty: false,
      localChangedSinceSync: true,
      localSavedAt: "2026-07-13T12:00:00.000Z",
    };
    this.#hooks.onSnapshotChange?.(this.#snapshot);
    return "saved";
  }

  async upload(): Promise<SyncActionResult> {
    this.uploadCalls += 1;
    return this.uploadResult;
  }

  async pull(): Promise<SyncActionResult> {
    this.pullCalls += 1;
    return this.pullResult;
  }

  async resolveConflict(strategy: "local-wins" | "cloud-wins"): Promise<SyncActionResult> {
    this.resolveCalls.push(strategy);
    return this.resolveResult ?? (strategy === "local-wins" ? "uploaded" : "reloaded");
  }

  async pollNow(): Promise<void> {
    this.pollCalls += 1;
  }

  getSnapshot(): ModuleRuntimeSnapshot {
    return this.#snapshot;
  }

  setDirty(dirty: boolean): void {
    this.#dirty = dirty;
    this.#snapshot = { ...this.#snapshot, sessionDirty: dirty };
  }

  setSnapshot(snapshot: Partial<ModuleRuntimeSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...snapshot };
    this.#dirty = this.#snapshot.sessionDirty;
    this.#hooks.onSnapshotChange?.(this.#snapshot);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

function rowNamed(controller: MindMapController, name: string): HTMLButtonElement {
  const row = [...controller.shell.elements.tree.querySelectorAll<HTMLButtonElement>(".library-row")]
    .find((candidate) => candidate.querySelector(".library-item-name")?.textContent?.replace(/ \*$/, "") === name);
  if (!row) throw new Error(`Missing library row: ${name}`);
  return row;
}

function key(
  target: EventTarget,
  value: string,
  modifiers: Pick<KeyboardEventInit, "ctrlKey" | "altKey" | "metaKey" | "shiftKey"> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchDrag(target: HTMLElement, type: string): void {
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

function dialogTitle(): string | null {
  return document.querySelector(".dialog-title")?.textContent ?? null;
}

function clickDialogChoice(label: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".dialog-button")]
    .find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Missing dialog choice: ${label}`);
  button.click();
}

function commandCallCount(runtime: FakeMindMapRuntime): number {
  return runtime.dispatched.length
    + runtime.undoCalls
    + runtime.redoCalls
    + runtime.saveCalls
    + runtime.uploadCalls
    + runtime.pullCalls
    + runtime.resolveCalls.length;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
