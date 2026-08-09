import type {
  ModuleRuntime,
  ModuleRuntimeHooks,
  ModuleRuntimeSnapshot,
  ModuleSyncAction,
  ProjectionReason,
  SettleReason,
} from "../../shared";
import { ModuleSyncUi } from "../../shared";
import {
  MindMapCanvas,
  type CanvasSelection,
  type CanvasTextCommitMode,
  type CanvasTextCommitResult,
  type CanvasTextChange,
} from "../canvas";
import {
  baseName,
  canConnect,
  createEmptyMindMapPayload,
  type MindMapDocument,
  type MindMapEndpoint,
  type MindMapEvent,
  type MindMapPayload,
} from "../domain";
import {
  LibraryTreeView,
  type LibraryDraft,
  type LibrarySelection,
  type SettledLibraryDraft,
} from "../library/treeView";
import { MindMapShell } from "../ui/shell";
import {
  mapReflectsTextChange,
  planAddNode,
  planCreateArrow,
  planDeleteCanvasSelection,
  planMoveNodes,
  planNodeFrame,
  planNodeText,
} from "./canvasCommands";
import {
  hasPendingLibraryChange,
  isLibraryPlanApplied,
  nearestExistingFolder,
  planLibraryDelete,
  planLibraryDraft,
  planLibraryMove,
  retainLibrarySelection,
  selectedParentPath,
  validateLibraryDraft,
  type LibraryCommandEffect,
} from "./libraryCommands";
import { routePageKeyCommand } from "./pageCommands";
import { computeDirtyLibraryState, findHistoryFocus } from "./payloadDiff";
import { MindMapPreferences } from "./preferences";

type MindMapRuntime = ModuleRuntime<MindMapPayload, MindMapEvent>;

export interface MindMapControllerOptions {
  readonly storage?: Storage | null;
  readonly createId?: () => string;
  readonly navigateHome?: () => void;
}

interface DraftCommit {
  readonly event: MindMapEvent | null;
  readonly expected: (payload: MindMapPayload) => boolean;
  readonly applyUi: () => void;
}

const EMPTY_SNAPSHOT: ModuleRuntimeSnapshot = {
  initialized: false,
      sessionDirty: false,
      localChangedSinceSync: false,
      businessChangedSinceSync: false,
      migrationChangedSinceSync: false,
  localSavedAt: null,
  knownRemoteRevision: null,
  knownRemoteUpdatedAt: null,
  lastSyncedRemoteRevision: null,
  pendingUpload: null,
  conflict: null,
};

/** Owns all module state and is the only Mind Map class allowed to access Shared. */
export class MindMapController {
  readonly shell: MindMapShell;
  readonly canvas: MindMapCanvas;
  readonly tree: LibraryTreeView;
  readonly syncUi: ModuleSyncUi;
  readonly hooks: ModuleRuntimeHooks<MindMapPayload, MindMapEvent>;

  readonly #preferences: MindMapPreferences;
  readonly #createId: () => string;
  readonly #navigateHome: () => void;
  readonly #pageWindow: Window;
  readonly #removeListeners: Array<() => void> = [];

  #runtime: MindMapRuntime | null = null;
  #payload: MindMapPayload = createEmptyMindMapPayload();
  #localBaseline: MindMapPayload = createEmptyMindMapPayload();
  #snapshot: ModuleRuntimeSnapshot = EMPTY_SNAPSHOT;
  #currentMapId: string | null = null;
  #librarySelection: LibrarySelection = null;
  #suppressCanvasSelection = false;
  #suppressCanvasRender = false;
  #pendingDraftCommit: DraftCommit | null = null;
  #autoSaveScheduled = false;
  #autoSavePromise: Promise<boolean> | null = null;
  #savingCommittedEvent = false;
  #localSaveFailed = false;
  #disposed = false;

  constructor(appRoot: HTMLElement, options: MindMapControllerOptions = {}) {
    const pageWindow = appRoot.ownerDocument.defaultView;
    if (!pageWindow) throw new Error("Mind Map requires a browser window.");
    this.#pageWindow = pageWindow;
    this.#preferences = new MindMapPreferences(options.storage);
    this.#createId = options.createId ?? defaultCreateId;
    this.#navigateHome = options.navigateHome ?? (() => {
      pageWindow.location.assign(new URL(import.meta.env.BASE_URL, pageWindow.location.href).href);
    });

    this.shell = new MindMapShell(appRoot);
    this.shell.setSidebarOpen(this.#preferences.snapshot.sidebarOpen);
    this.syncUi = new ModuleSyncUi({
      mount: this.shell.elements.syncMount,
      guardAction: (action) => this.#guardSyncAction(action),
    });

    this.canvas = new MindMapCanvas(this.shell.elements.canvasMount, {
      measurements: {
        getCanvasRect: (svg) => rectLike(svg.getBoundingClientRect()),
        getSidebarRect: () => !this.shell.elements.root.classList.contains("sidebar-open")
          ? null
          : stableSidebarRect(
              this.shell.elements.sidebar,
              this.shell.elements.canvasArea,
            ),
      },
      callbacks: {
        onArrowModeChange: (enabled) => this.shell.setArrowMode(enabled),
        onSelectionChange: (selection) => this.#onCanvasSelectionChange(selection),
        onAddNodeRequest: ({ position }) => this.#addNode(position),
        onMoveNodes: ({ nodeIds, dx, dy }) => this.#moveNodes(nodeIds, dx, dy),
        onResizeNode: ({ nodeId, frame, autoWidth }) => {
          const event = planNodeFrame(this.#currentMapId, nodeId, frame, autoWidth);
          if (event) this.#dispatch(event);
        },
        onChangeNodeText: (change, mode) => this.#commitTextChange(change, mode),
        onCreateArrow: ({ from, to }) => this.#createArrow(from, to),
        isArrowTargetValid: (from, to) => this.#isArrowTargetValid(from, to),
      },
    });

    this.tree = new LibraryTreeView(
      this.shell.elements.tree,
      this.shell.elements.rootDropTarget,
      {
        onSelect: (selection) => this.#selectLibrary(selection),
        onOpenMap: (mapId) => this.#openMap(mapId),
        onToggleFolder: (path, expanded) => this.#toggleFolder(path, expanded),
        onMove: (selection, destination) => this.#moveLibraryItem(selection, destination),
        validateDraft: (draft, value) => this.#validateDraft(draft, value),
        commitDraft: (draft, value) => this.#commitLibraryDraft(draft, value),
      },
    );

    this.hooks = {
      settle: (reason) => this.#settle(reason),
      project: (payload, reason) => this.#project(payload, reason),
      onSnapshotChange: (snapshot) => this.#onSnapshotChange(snapshot),
    };

    this.#bindUi();
    this.#render(true);
  }

  attachRuntime(runtime: MindMapRuntime, initialPayload: MindMapPayload): void {
    this.#assertAlive();
    this.#runtime = runtime;
    this.#payload = initialPayload;
    this.#localBaseline = initialPayload;
    this.#snapshot = runtime.getSnapshot();
    this.syncUi.attachRuntime(runtime);
    this.#restoreInitialMap();
    this.#render(true);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const remove of this.#removeListeners.splice(0)) remove();
    this.tree.dispose();
    this.canvas.dispose();
    this.syncUi.dispose();
    this.shell.dispose();
    const runtime = this.#runtime;
    this.#runtime = null;
    await runtime?.dispose();
  }

  #bindUi(): void {
    const elements = this.shell.elements;
    this.#listen(elements.sidebarButton, "click", () => {
      const open = !elements.root.classList.contains("sidebar-open");
      this.#preferences.setSidebarOpen(open);
      this.shell.setSidebarOpen(open);
    });
    this.#listen(elements.homeButton, "click", () => void this.#returnHome());
    this.#listen(elements.retrySaveButton, "click", () => void this.#retryLocalSave());
    this.#listen(elements.addNodeButton, "click", () => this.#requestAddNode());
    this.#listen(elements.addArrowButton, "click", () => this.#toggleArrowMode());
    this.#listen(elements.resetViewButton, "click", () => this.canvas.resetViewport());
    this.#listen(elements.newFolderButton, "click", () => this.#beginCreate("folder"));
    this.#listen(elements.newMapButton, "click", () => this.#beginCreate("map"));
    this.#listen(elements.renameButton, "click", () => this.#beginRename());
    this.#listen(elements.deleteButton, "click", () => void this.#confirmDeleteLibrarySelection());
    this.#listen(elements.sidebar, "pointerdown", (event) => {
      const target = event.target as Element | null;
      if (
        event.button !== 0
        || target?.closest("button, input, .library-inline-editor")
      ) return;
      if (this.tree.settleDraft(false)) this.#clearLibrarySelection();
    });
    this.#listen(this.#pageWindow.document, "pointerdown", (event) => {
      if (
        !this.tree.draft
        || elements.sidebar.contains(event.target as Node | null)
      ) return;
      this.tree.settleDraft(false);
    });

    this.#listen(this.canvas.element, "pointerdown", () => {
      if (this.tree.settleDraft(false)) this.#clearLibrarySelection();
    });
    this.#listen(this.#pageWindow.document, "keydown", (event) => this.#onKeyDown(event), true);
    this.#listen(this.#pageWindow, "beforeunload", (event) => this.#onBeforeUnload(event));
  }

  #listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    capture?: boolean,
  ): void;
  #listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    capture?: boolean,
  ): void;
  #listen<K extends keyof GlobalEventHandlersEventMap>(
    target: Element,
    type: K,
    listener: (event: GlobalEventHandlersEventMap[K]) => void,
    capture?: boolean,
  ): void;
  #listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    capture = false,
  ): void {
    target.addEventListener(type, listener, capture);
    this.#removeListeners.push(() => target.removeEventListener(type, listener, capture));
  }

  #project(payload: MindMapPayload, reason: ProjectionReason): void {
    this.tree.cancelLiveInteraction();
    this.#payload = payload;
    this.#preferences.retainFolders(payload.folders);
    if (reason === "initialize") this.#restoreInitialMap();
    if (this.#currentMapId && !this.#findMap(this.#currentMapId)) {
      this.#currentMapId = null;
      this.#preferences.setLastMapId(null);
    }
    this.#librarySelection = retainLibrarySelection(this.#librarySelection, payload);
    this.tree?.cancelDraft();
    this.#render(true);
  }

  #onSnapshotChange(snapshot: ModuleRuntimeSnapshot): void {
    const previousPayloadKey = payloadKey(this.#payload);
    const previousBaselineKey = payloadKey(this.#localBaseline);
    this.#snapshot = snapshot;
    if (this.#runtime?.state === "ready") this.#payload = this.#runtime.current;
    if (!snapshot.sessionDirty) {
      this.#localBaseline = this.#payload;
      this.#localSaveFailed = false;
    }
    let requiresProjection = previousPayloadKey !== payloadKey(this.#payload)
      || previousBaselineKey !== payloadKey(this.#localBaseline);
    const pending = this.#pendingDraftCommit;
    this.#pendingDraftCommit = null;
    if (pending && pending.expected(this.#payload)) {
      pending.applyUi();
      requiresProjection = true;
    }
    if (requiresProjection) this.#render(false);
    else this.#renderSnapshot();
  }

  #settle(reason: SettleReason): MindMapEvent | null {
    if (reason === "local-save" && this.#savingCommittedEvent) return null;
    this.tree.cancelLiveInteraction();
    const settledDraft = this.tree.takeDraftForSettle(true);
    if (settledDraft) {
      this.canvas.cancelLiveInteraction();
      const commit = this.#buildDraftCommit(settledDraft);
      this.#pendingDraftCommit = commit;
      this.#clearSelections();
      return commit.event;
    }
    const text = this.canvas.settleLiveInteraction();
    this.#librarySelection = null;
    this.#renderTree();
    return text ? this.#textEvent(text) : null;
  }

  #restoreInitialMap(): void {
    const preferred = this.#preferences.snapshot.lastMapId;
    this.#currentMapId = preferred && this.#findMap(preferred) ? preferred : null;
    if (!this.#currentMapId && preferred) this.#preferences.setLastMapId(null);
  }

  #render(forceProjection: boolean): void {
    if (!this.tree || !this.canvas) return;
    const map = this.#currentMapId ? this.#findMap(this.#currentMapId) : null;
    if (!map && this.#currentMapId) {
      this.#currentMapId = null;
      this.#preferences.setLastMapId(null);
    }
    const dirty = computeDirtyLibraryState(this.#payload, this.#localBaseline);
    this.shell.setMapTitle(map ? baseName(map.path) : null, Boolean(map && dirty.mapIds.has(map.id)));
    this.#renderSnapshot();
    this.shell.setLibrarySelectionAvailable(this.#librarySelection !== null);
    this.#renderTree(dirty);
    if (this.#suppressCanvasRender) return;

    this.#suppressCanvasSelection = true;
    try {
      if (forceProjection) this.canvas.project(map);
      else this.canvas.render(map);
    } finally {
      this.#suppressCanvasSelection = false;
    }
  }

  #renderTree(dirty = computeDirtyLibraryState(this.#payload, this.#localBaseline)): void {
    this.tree.render({
      payload: this.#payload,
      selection: this.#librarySelection,
      currentMapId: this.#currentMapId,
      expandedFolders: this.#preferences.snapshot.expandedFolders,
      dirtyMapIds: dirty.mapIds,
      dirtyFolderPaths: dirty.folderPaths,
    });
    this.shell.setLibrarySelectionAvailable(this.#librarySelection !== null);
  }

  #dispatch(event: MindMapEvent, after?: () => void): boolean {
    const runtime = this.#runtime;
    if (!runtime) return false;
    try {
      this.#payload = runtime.dispatch(event);
      after?.();
      this.#render(false);
      this.#scheduleAutoSave();
      return true;
    } catch {
      this.shell.showMessage("这次修改未能完成，请稍后重试。", "error");
      return false;
    }
  }

  #onCanvasSelectionChange(_selection: CanvasSelection): void {
    if (this.#suppressCanvasSelection) return;
    this.#clearLibrarySelection();
  }

  #clearLibrarySelection(): void {
    if (this.#librarySelection === null) return;
    this.#librarySelection = null;
    this.#renderTree();
  }

  #selectLibrary(selection: LibrarySelection): void {
    this.#suppressCanvasSelection = true;
    try {
      this.canvas.clearSelection();
      this.canvas.setArrowMode(false);
    } finally {
      this.#suppressCanvasSelection = false;
    }
    this.#librarySelection = selection;
    this.#renderTree();
    if (selection) {
      this.#pageWindow.queueMicrotask(() => this.tree.focusSelection(selection));
    }
  }

  #clearSelections(): void {
    this.#librarySelection = null;
    this.#suppressCanvasSelection = true;
    try {
      this.canvas.clearSelection();
    } finally {
      this.#suppressCanvasSelection = false;
    }
    this.#renderTree();
  }

  #openMap(mapId: string): void {
    const map = this.#findMap(mapId);
    if (!map) return;
    this.canvas.commitActiveTextEdit();
    this.#currentMapId = mapId;
    this.#librarySelection = { kind: "map", mapId };
    this.#preferences.setLastMapId(mapId);
    this.#preferences.expandAncestors(map.path);
    this.#render(true);
  }

  #toggleFolder(path: string, expanded: boolean): void {
    this.#preferences.setFolderExpanded(path, expanded);
    if (expanded && this.tree.dragging) {
      this.tree.expandFolderDuringDrag(path);
      return;
    }
    this.#renderTree();
  }

  #prepareLibraryCommand(): void {
    this.tree.cancelLiveInteraction();
    this.tree.settleDraft(true);
    this.canvas.commitActiveTextEdit();
    this.canvas.cancelLiveInteraction();
  }

  #beginCreate(kind: "folder" | "map"): void {
    this.#prepareLibraryCommand();
    const parent = this.#selectedParentPath();
    if (parent) this.#preferences.setFolderExpanded(parent, true);
    this.#librarySelection = null;
    this.#renderTree();
    this.shell.setLibrarySelectionAvailable(false);
    this.tree.beginCreate(kind, parent);
  }

  #beginRename(): void {
    const selection = this.#librarySelection;
    if (!selection) return;
    this.#prepareLibraryCommand();
    this.tree.beginRename(selection);
  }

  #selectedParentPath(): string {
    return selectedParentPath(this.#payload, this.#librarySelection);
  }

  #validateDraft(draft: LibraryDraft, value: string): string | null {
    return validateLibraryDraft(this.#payload, draft, value);
  }

  #commitLibraryDraft(draft: LibraryDraft, value: string): string | null {
    const validation = this.#validateDraft(draft, value);
    if (validation) return validation;
    try {
      const commit = this.#buildDraftCommit({ draft, value });
      if (commit.event && !this.#dispatch(commit.event)) return "修改未能保存到暂存层，请重试。";
      if (commit.expected(this.#payload)) commit.applyUi();
      this.#render(false);
      return null;
    } catch {
      return "名称或目标位置无效。";
    }
  }

  #buildDraftCommit(settled: SettledLibraryDraft): DraftCommit {
    const plan = planLibraryDraft(this.#payload, settled, this.#createId);
    return {
      event: plan.event,
      expected: (payload) => isLibraryPlanApplied(payload, plan),
      applyUi: () => this.#applyLibraryEffect(plan.effect),
    };
  }

  #applyLibraryEffect(effect: LibraryCommandEffect): void {
    switch (effect.type) {
      case "select-folder":
        if (effect.parentPath) this.#preferences.setFolderExpanded(effect.parentPath, true);
        this.#librarySelection = { kind: "folder", path: effect.path };
        return;
      case "open-map":
        if (effect.parentPath) this.#preferences.setFolderExpanded(effect.parentPath, true);
        this.#currentMapId = effect.mapId;
        this.#librarySelection = { kind: "map", mapId: effect.mapId };
        this.#preferences.setLastMapId(effect.mapId);
        this.#preferences.expandAncestors(effect.path);
        return;
      case "remap-folder":
        this.#preferences.remapFolderPrefix(effect.fromPath, effect.toPath);
        this.#librarySelection = { kind: "folder", path: effect.toPath };
        return;
      case "select-map":
        this.#librarySelection = { kind: "map", mapId: effect.mapId };
        this.#preferences.expandAncestors(effect.path);
    }
  }

  #moveLibraryItem(selection: Exclude<LibrarySelection, null>, destination: string): void {
    this.#prepareLibraryCommand();
    try {
      const plan = planLibraryMove(this.#payload, selection, destination);
      if (plan.status === "noop") return;
      if (plan.status === "invalid") {
        this.shell.showMessage(plan.message, "error");
        return;
      }
      this.#dispatch(plan.event, () => {
        this.#applyLibraryEffect(plan.effect);
        if (destination) this.#preferences.setFolderExpanded(destination, true);
      });
    } catch {
      this.shell.showMessage("这个项目不能移动到所选位置。", "error");
    }
  }

  async #confirmDeleteLibrarySelection(): Promise<void> {
    const selection = this.#librarySelection;
    if (!selection) return;
    this.#prepareLibraryCommand();
    const folder = selection.kind === "folder";
    const choice = await this.shell.choose(
      folder ? "删除文件夹" : "删除脑图",
      folder
        ? "将递归删除该文件夹、全部子文件夹和其中的所有脑图。此操作可以撤销。"
        : "将删除这张脑图。此操作可以撤销。",
      [
        { id: "cancel", label: "取消" },
        { id: "delete", label: "删除", tone: "danger" },
      ],
    );
    if (choice !== "delete") return;
    const plan = planLibraryDelete(this.#payload, selection, this.#currentMapId);
    this.#dispatch(plan.event, () => {
      if (plan.closesCurrentMap) {
        this.#currentMapId = null;
        this.#preferences.setLastMapId(null);
      }
      this.#librarySelection = selection.kind === "folder"
        ? nearestExistingFolder(plan.fallbackFolderPath, this.#payload)
        : null;
    });
  }

  #requestAddNode(): void {
    this.#commitPendingUi();
    this.#clearLibrarySelection();
    this.canvas.requestAddNode();
  }

  #addNode(position: { readonly x: number; readonly y: number }): void {
    const mapId = this.#currentMapId;
    if (!mapId) return;
    const nodeId = this.#createId();
    const added = this.#dispatch(planAddNode(mapId, nodeId, position));
    if (added) this.canvas.editNode(nodeId);
  }

  #moveNodes(nodeIds: readonly string[], dx: number, dy: number): void {
    const map = this.#currentMap();
    if (!map) return;
    const event = planMoveNodes(map, nodeIds, dx, dy);
    if (event) this.#dispatch(event);
  }

  #commitTextChange(
    change: CanvasTextChange,
    mode: CanvasTextCommitMode,
  ): CanvasTextCommitResult {
    const event = this.#textEvent(change);
    const currentMap = this.#currentMap();
    if (!event || !currentMap) return { accepted: false };
    const preserveCanvasDom = mode === "pointer-handoff";
    if (preserveCanvasDom) this.#suppressCanvasRender = true;
    try {
      const dispatched = this.#dispatch(event);
      const map = this.#currentMap();
      return map && (dispatched || mapReflectsTextChange(map, change))
        ? { accepted: true, map }
        : { accepted: false };
    } finally {
      if (preserveCanvasDom) this.#suppressCanvasRender = false;
    }
  }

  #textEvent(change: CanvasTextChange): MindMapEvent | null {
    return planNodeText(this.#currentMapId, change);
  }

  #createArrow(from: MindMapEndpoint, to: MindMapEndpoint): void {
    const map = this.#currentMap();
    if (!map || !canConnect(map, from, to)) return;
    const event = planCreateArrow(map, this.#createId(), from, to);
    if (!event) return;
    this.#dispatch(event);
  }

  #isArrowTargetValid(from: MindMapEndpoint, to: MindMapEndpoint): boolean {
    const map = this.#currentMap();
    return Boolean(map && canConnect(map, from, to));
  }

  #toggleArrowMode(): void {
    if (this.canvas.arrowMode) {
      this.canvas.setArrowMode(false);
      return;
    }
    this.#commitPendingUi();
    this.#clearLibrarySelection();
    this.canvas.setArrowMode(true);
  }

  #deleteCanvasSelection(selection = this.canvas.getSelection()): void {
    const event = planDeleteCanvasSelection(this.#currentMapId, selection);
    if (event) this.#dispatch(event);
  }

  #commitPendingUi(): void {
    this.tree.cancelLiveInteraction();
    this.tree.settleDraft(true);
    this.canvas.commitActiveTextEdit();
    this.canvas.cancelLiveInteraction();
  }

  async #undo(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) return;
    const before = runtime.current;
    try {
      const after = await runtime.undo();
      this.#payload = after;
      this.#applyHistoryFocus(findHistoryFocus(before, after));
      this.#render(true);
      await this.#saveAfterMutation();
    } catch {
      this.shell.showMessage("撤销未能完成，请重试。", "error");
    }
  }

  async #redo(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) return;
    const before = runtime.current;
    try {
      const after = await runtime.redo();
      this.#payload = after;
      this.#applyHistoryFocus(findHistoryFocus(before, after));
      this.#render(true);
      await this.#saveAfterMutation();
    } catch {
      this.shell.showMessage("重做未能完成，请重试。", "error");
    }
  }

  #applyHistoryFocus(focus: ReturnType<typeof findHistoryFocus>): void {
    if (focus.mapIdToOpen && this.#findMap(focus.mapIdToOpen)) {
      this.#currentMapId = focus.mapIdToOpen;
      this.#preferences.setLastMapId(focus.mapIdToOpen);
      const map = this.#findMap(focus.mapIdToOpen)!;
      this.#preferences.expandAncestors(map.path);
    }
    if (focus.selection?.kind === "folder") {
      this.#preferences.expandAncestors(focus.selection.path);
    }
    this.#librarySelection = focus.selection;
    if (focus.selection) {
      this.#pageWindow.queueMicrotask(() => this.tree.focusSelection(focus.selection!));
    }
  }

  #scheduleAutoSave(): void {
    if (this.#autoSaveScheduled || this.#disposed) return;
    this.#autoSaveScheduled = true;
    this.#pageWindow.queueMicrotask(() => {
      if (!this.#autoSaveScheduled || this.#disposed) return;
      this.#autoSaveScheduled = false;
      this.#startAutoSave();
    });
  }

  #startAutoSave(): void {
    if (this.#autoSavePromise || this.#disposed) return;
    const operation = this.#saveAfterMutation();
    this.#autoSavePromise = operation;
    void operation.then(() => {
      if (this.#autoSavePromise === operation) this.#autoSavePromise = null;
    });
  }

  async #flushAutoSave(): Promise<boolean> {
    if (this.#autoSaveScheduled) {
      this.#autoSaveScheduled = false;
      this.#startAutoSave();
    }
    return await (this.#autoSavePromise ?? Promise.resolve(true));
  }

  async #retryLocalSave(): Promise<boolean> {
    await this.#flushAutoSave();
    return await this.#saveAfterMutation(true, false);
  }

  async #saveAfterMutation(
    showRetrySuccess = false,
    savingCommittedEvent = true,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    if (!runtime) return false;
    this.#savingCommittedEvent = savingCommittedEvent;
    try {
      await runtime.save();
      this.#localSaveFailed = false;
      this.#renderSnapshot();
      if (showRetrySuccess) this.shell.showMessage("已重新保存到本机。");
      return true;
    } catch {
      this.#localSaveFailed = true;
      this.#renderSnapshot();
      this.shell.showMessage("自动保存到本机失败，内容和撤销历史均已保留。", "error");
      return false;
    } finally {
      this.#savingCommittedEvent = false;
    }
  }

  #guardSyncAction(action: ModuleSyncAction): { readonly status: "ready" } {
    if (action === "pull") this.#commitPendingUi();
    return { status: "ready" };
  }

  async #returnHome(): Promise<void> {
    this.#commitPendingUi();
    await this.#flushAutoSave();
    const runtime = this.#runtime;
    if (!runtime || !runtime.dirty) {
      this.#navigateHome();
      return;
    }
    const choice = await this.shell.choose(
      "返回首页",
      "还有尚未保存到本机的内容。",
      [
        { id: "cancel", label: "取消" },
        { id: "save", label: "重试保存并返回", tone: "primary" },
        { id: "discard", label: "不保存返回", tone: "danger" },
      ],
    );
    if (choice === "discard") this.#navigateHome();
    if (choice === "save" && await this.#retryLocalSave()) this.#navigateHome();
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (this.shell.dialogOpen || this.#pageWindow.document.querySelector("dialog[open]")) return;
    const selection = this.canvas.getSelection();
    const targetIsNode = isDomNode(event.target);
    const command = routePageKeyCommand({
      key: event.key,
      defaultPrevented: event.defaultPrevented,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      textEditing: isTextEditingTarget(event.target),
      withinLibrary: targetIsNode && this.shell.elements.sidebar.contains(event.target as Node),
      hasLibrarySelection: this.#librarySelection !== null,
      hasCanvasSelection: selection.nodeIds.length > 0 || selection.arrowIds.length > 0,
    });
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();

    switch (command) {
      case "suppress-redo-shortcut":
        return;
      case "undo":
        void this.#undo();
        return;
      case "redo":
        void this.#redo();
        return;
      case "add-node":
        this.#commitPendingUi();
        this.#clearLibrarySelection();
        this.canvas.requestAddNode();
        return;
      case "add-arrow":
        this.#commitPendingUi();
        this.#clearLibrarySelection();
        this.canvas.setArrowMode(true);
        return;
      case "delete-library":
        void this.#confirmDeleteLibrarySelection();
        return;
      case "delete-canvas":
        this.#deleteCanvasSelection(selection);
    }
  }

  #onBeforeUnload(event: BeforeUnloadEvent): void {
    if (
      !this.#runtime?.dirty
      && !this.#localSaveFailed
      && !this.canvas.hasPendingTextChange()
      && !this.#hasPendingLibraryChange()
    ) return;
    event.preventDefault();
    event.returnValue = "";
  }

  #renderSnapshot(): void {
    this.syncUi.renderSnapshot(this.#snapshot);
    this.syncUi.setLocalSaveFailed(this.#localSaveFailed);
    this.shell.setSaveRetryVisible(this.#localSaveFailed);
  }

  #hasPendingLibraryChange(): boolean {
    return hasPendingLibraryChange(this.#payload, this.tree.draft, this.tree.draftValue);
  }

  #findMap(id: string): MindMapDocument | null {
    return this.#payload.maps.find((map) => map.id === id) ?? null;
  }

  #currentMap(): MindMapDocument | null {
    return this.#currentMapId ? this.#findMap(this.#currentMapId) : null;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("Mind Map controller is disposed.");
  }
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  return Boolean(
    target
    && "matches" in target
    && typeof target.matches === "function"
    && target.matches("input, textarea, [contenteditable='true']"),
  );
}

function isDomNode(target: EventTarget | null): target is Node {
  return Boolean(target && "nodeType" in target && typeof target.nodeType === "number");
}

function rectLike(rect: DOMRect): { left: number; top: number; width: number; height: number } {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function stableSidebarRect(
  sidebar: HTMLElement,
  canvasArea: HTMLElement,
): { left: number; top: number; width: number; height: number } {
  const canvasRect = canvasArea.getBoundingClientRect();
  return {
    left: canvasRect.left + sidebar.offsetLeft,
    top: canvasRect.top + sidebar.offsetTop,
    width: sidebar.offsetWidth,
    height: sidebar.offsetHeight,
  };
}

function payloadKey(payload: MindMapPayload): string {
  return JSON.stringify(payload);
}

function defaultCreateId(): string {
  return globalThis.crypto.randomUUID();
}
