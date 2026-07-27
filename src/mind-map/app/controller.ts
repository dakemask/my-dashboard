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
  comparableLibraryName,
  createEmptyMindMapPayload,
  isSameOrDescendant,
  normalizeFolderName,
  normalizeMapName,
  parentPath,
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
import { computeDirtyLibraryState, findHistoryFocus } from "./payloadDiff";
import { MindMapPreferences } from "./preferences";

const DEFAULT_NODE_WIDTH = 260;
const DEFAULT_NODE_HEIGHT = 92;

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
        onSelectionChange: (selection) => this.#onCanvasSelectionChange(selection),
        onAddNodeRequest: ({ position }) => this.#addNode(position),
        onMoveNodes: ({ nodeIds, dx, dy }) => this.#moveNodes(nodeIds, dx, dy),
        onResizeNode: ({ nodeId, frame, autoWidth }) => {
          const mapId = this.#currentMapId;
          if (!mapId) return;
          this.#dispatch({ type: "set-node-frame", mapId, nodeId, frame, autoWidth });
        },
        onChangeNodeText: (change, mode) => this.#commitTextChange(change, mode),
        onCreateArrow: ({ from, to }) => this.#createArrow(from, to),
        onDeleteSelection: (selection) => this.#deleteCanvasSelection(selection),
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

    const updateArrowButton = (): void => {
      this.#pageWindow.queueMicrotask(() => this.shell.setArrowMode(this.canvas.arrowMode));
    };
    this.#listen(this.canvas.element, "pointerdown", () => {
      if (this.tree.settleDraft(false)) this.#clearLibrarySelection();
    });
    this.#listen(this.canvas.element, "pointerdown", updateArrowButton);
    this.#listen(this.canvas.element, "pointerup", updateArrowButton);
    this.#listen(this.canvas.element, "pointercancel", updateArrowButton);
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
    this.shell.setArrowMode(this.canvas.arrowMode);
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
    this.shell.setArrowMode(false);
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
    this.shell.setArrowMode(false);
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
    const selection = this.#librarySelection;
    if (selection?.kind === "folder") return selection.path;
    if (selection?.kind === "map") return parentPath(this.#findMap(selection.mapId)?.path ?? "");
    return "";
  }

  #validateDraft(draft: LibraryDraft, value: string): string | null {
    try {
      const kind = draftKind(draft);
      const name = kind === "folder" ? normalizeFolderName(value) : normalizeMapName(value);
      const parent = draftParent(draft, this.#payload);
      if (kind === "map" && parent === "" && comparableLibraryName(name, "map") === "revision") {
        return "根目录的脑图不能命名为 revision。";
      }
      const excluded = draft.kind === "rename" ? draft.selection : null;
      if (hasSibling(this.#payload, parent, name, kind, excluded)) {
        return kind === "folder" ? "同一层已有同名文件夹。" : "同一层已有同名脑图。";
      }
      return null;
    } catch (error) {
      return error instanceof TypeError ? error.message : "名称无效。";
    }
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
    const { draft, value } = settled;
    const kind = draftKind(draft);
    const name = kind === "folder" ? normalizeFolderName(value) : normalizeMapName(value);
    if (draft.kind === "new-folder") {
      const path = joinPath(draft.parentPath, name);
      return {
        event: { type: "create-folder", path },
        expected: (payload) => payload.folders.includes(path),
        applyUi: () => {
          if (draft.parentPath) this.#preferences.setFolderExpanded(draft.parentPath, true);
          this.#librarySelection = { kind: "folder", path };
        },
      };
    }
    if (draft.kind === "new-map") {
      const id = this.#createId();
      const path = joinPath(draft.parentPath, name);
      const map: MindMapDocument = { id, path, nodes: [], arrows: [] };
      return {
        event: { type: "create-map", map },
        expected: (payload) => payload.maps.some((candidate) => candidate.id === id),
        applyUi: () => {
          if (draft.parentPath) this.#preferences.setFolderExpanded(draft.parentPath, true);
          this.#currentMapId = id;
          this.#librarySelection = { kind: "map", mapId: id };
          this.#preferences.setLastMapId(id);
          this.#preferences.expandAncestors(path);
        },
      };
    }
    if (draft.selection.kind === "folder") {
      const fromPath = draft.selection.path;
      const toPath = joinPath(parentPath(fromPath), name);
      return {
        event: toPath === fromPath ? null : { type: "relocate-folder", fromPath, toPath },
        expected: (payload) => payload.folders.includes(toPath),
        applyUi: () => {
          this.#preferences.remapFolderPrefix(fromPath, toPath);
          this.#librarySelection = { kind: "folder", path: toPath };
        },
      };
    }
    const mapId = draft.selection.mapId;
    const map = this.#findMap(mapId);
    if (!map) throw new TypeError("脑图已不存在。");
    const path = joinPath(parentPath(map.path), name);
    return {
      event: path === map.path ? null : { type: "relocate-map", mapId, path },
      expected: (payload) => payload.maps.some((candidate) => candidate.id === mapId && candidate.path === path),
      applyUi: () => {
        this.#librarySelection = { kind: "map", mapId };
        this.#preferences.expandAncestors(path);
      },
    };
  }

  #moveLibraryItem(selection: Exclude<LibrarySelection, null>, destination: string): void {
    this.#prepareLibraryCommand();
    try {
      if (selection.kind === "folder") {
        const fromPath = selection.path;
        if (destination && isSameOrDescendant(destination, fromPath)) {
          this.shell.showMessage("文件夹不能移动到自身或其子文件夹中。", "error");
          return;
        }
        const toPath = joinPath(destination, baseName(fromPath));
        if (toPath === fromPath) return;
        if (hasSibling(this.#payload, destination, baseName(fromPath), "folder", selection)) {
          this.shell.showMessage("目标位置已有同名文件夹。", "error");
          return;
        }
        this.#dispatch(
          { type: "relocate-folder", fromPath, toPath },
          () => {
            this.#preferences.remapFolderPrefix(fromPath, toPath);
            if (destination) this.#preferences.setFolderExpanded(destination, true);
            this.#librarySelection = { kind: "folder", path: toPath };
          },
        );
        return;
      }
      const map = this.#findMap(selection.mapId);
      if (!map) return;
      const path = joinPath(destination, baseName(map.path));
      if (path === map.path) return;
      if (hasSibling(this.#payload, destination, baseName(map.path), "map", selection)) {
        this.shell.showMessage("目标位置已有同名脑图。", "error");
        return;
      }
      this.#dispatch({ type: "relocate-map", mapId: map.id, path }, () => {
        if (destination) this.#preferences.setFolderExpanded(destination, true);
        this.#librarySelection = { kind: "map", mapId: map.id };
        this.#preferences.expandAncestors(path);
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
        { id: "delete", label: "删除", tone: "danger" },
        { id: "cancel", label: "取消" },
      ],
    );
    if (choice !== "delete") return;
    if (selection.kind === "folder") {
      const current = this.#currentMapId ? this.#findMap(this.#currentMapId) : null;
      this.#dispatch({ type: "delete-folder", path: selection.path }, () => {
        if (current && isSameOrDescendant(current.path, selection.path)) {
          this.#currentMapId = null;
          this.#preferences.setLastMapId(null);
        }
        this.#librarySelection = nearestExistingFolder(parentPath(selection.path), this.#payload);
      });
      return;
    }
    this.#dispatch({ type: "delete-map", mapId: selection.mapId }, () => {
      if (this.#currentMapId === selection.mapId) {
        this.#currentMapId = null;
        this.#preferences.setLastMapId(null);
      }
      this.#librarySelection = null;
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
    const added = this.#dispatch({
      type: "add-node",
      mapId,
      node: {
        id: nodeId,
        text: "",
        x: position.x - DEFAULT_NODE_WIDTH / 2,
        y: position.y - DEFAULT_NODE_HEIGHT / 2,
        width: DEFAULT_NODE_WIDTH,
        height: DEFAULT_NODE_HEIGHT,
        autoWidth: false,
      },
    });
    if (added) this.canvas.editNode(nodeId);
  }

  #moveNodes(nodeIds: readonly string[], dx: number, dy: number): void {
    const map = this.#currentMap();
    if (!map) return;
    const selected = new Set(nodeIds);
    const positions = map.nodes
      .filter((node) => selected.has(node.id))
      .map((node) => ({ nodeId: node.id, x: node.x + dx, y: node.y + dy }));
    if (positions.length > 0) this.#dispatch({ type: "move-nodes", mapId: map.id, positions });
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
    const mapId = this.#currentMapId;
    if (!mapId) return null;
    return {
      type: "set-node-text",
      mapId,
      nodeId: change.nodeId,
      text: change.text,
      frame: change.frame,
      autoWidth: change.autoWidth,
    };
  }

  #createArrow(from: MindMapEndpoint, to: MindMapEndpoint): void {
    const mapId = this.#currentMapId;
    if (!mapId || !this.#isArrowTargetValid(from, to)) return;
    this.#dispatch({
      type: "add-arrow",
      mapId,
      arrow: { id: this.#createId(), from, to },
    });
    this.shell.setArrowMode(false);
  }

  #isArrowTargetValid(from: MindMapEndpoint, to: MindMapEndpoint): boolean {
    const map = this.#currentMap();
    return Boolean(
      map
      && from.nodeId !== to.nodeId
      && !map.arrows.some((arrow) => sameEndpoint(arrow.from, from) && sameEndpoint(arrow.to, to)),
    );
  }

  #toggleArrowMode(): void {
    if (this.canvas.arrowMode) {
      this.canvas.setArrowMode(false);
      this.shell.setArrowMode(false);
      return;
    }
    this.#commitPendingUi();
    this.#clearLibrarySelection();
    this.canvas.setArrowMode(true);
    this.shell.setArrowMode(true);
  }

  #deleteCanvasSelection(selection = this.canvas.getSelection()): void {
    const mapId = this.#currentMapId;
    if (!mapId || (selection.nodeIds.length === 0 && selection.arrowIds.length === 0)) return;
    this.#dispatch({
      type: "delete-objects",
      mapId,
      nodeIds: selection.nodeIds,
      arrowIds: selection.arrowIds,
    });
  }

  #commitPendingUi(): void {
    this.tree.cancelLiveInteraction();
    this.tree.settleDraft(true);
    this.canvas.commitActiveTextEdit();
    this.canvas.cancelLiveInteraction();
    this.shell.setArrowMode(false);
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
        { id: "save", label: "重试保存并返回", tone: "primary" },
        { id: "discard", label: "不保存返回", tone: "danger" },
        { id: "cancel", label: "取消" },
      ],
    );
    if (choice === "discard") this.#navigateHome();
    if (choice === "save" && await this.#retryLocalSave()) this.#navigateHome();
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    const exactControl = event.ctrlKey && !event.altKey && !event.metaKey;
    if (exactControl && event.shiftKey && key === "z") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (exactControl && !event.shiftKey && (key === "z" || key === "y")) {
      event.preventDefault();
      event.stopPropagation();
      if (key === "z") void this.#undo();
      else void this.#redo();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "1" || event.key === "2")) {
      event.preventDefault();
      event.stopPropagation();
      this.#commitPendingUi();
      this.#clearLibrarySelection();
      if (event.key === "1") this.canvas.requestAddNode();
      else {
        this.canvas.setArrowMode(true);
        this.shell.setArrowMode(this.canvas.arrowMode);
      }
      return;
    }
    if (
      event.key === "F2"
      && !event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && !event.shiftKey
      && this.#librarySelection
      && !isTextEditingTarget(event.target)
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.#beginRename();
      return;
    }
    if (event.key !== "Delete" || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (isTextEditingTarget(event.target)) return;
    if (this.shell.elements.sidebar.contains(event.target as Node) && this.#librarySelection) {
      event.preventDefault();
      event.stopPropagation();
      void this.#confirmDeleteLibrarySelection();
      return;
    }
    const selection = this.canvas.getSelection();
    if (selection.nodeIds.length > 0 || selection.arrowIds.length > 0) {
      event.preventDefault();
      event.stopPropagation();
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
    const draft = this.tree.draft;
    const value = this.tree.draftValue;
    if (!draft || value === null || this.#validateDraft(draft, value) !== null) return false;
    if (draft.kind === "new-folder" || draft.kind === "new-map") return true;
    if (draft.selection.kind === "folder") {
      const selectedPath = draft.selection.path;
      const current = this.#payload.folders.find((path) => path === selectedPath);
      return current !== undefined && normalizeFolderName(value) !== baseName(current);
    }
    const current = this.#findMap(draft.selection.mapId);
    return current !== null && normalizeMapName(value) !== baseName(current.path);
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

function mapReflectsTextChange(map: MindMapDocument, change: CanvasTextChange): boolean {
  const node = map.nodes.find((candidate) => candidate.id === change.nodeId);
  return Boolean(
    node
    && node.text === change.text
    && node.x === change.frame.x
    && node.y === change.frame.y
    && node.width === change.frame.width
    && node.height === change.frame.height
    && node.autoWidth === change.autoWidth,
  );
}

function draftKind(draft: LibraryDraft): "folder" | "map" {
  if (draft.kind === "new-folder") return "folder";
  if (draft.kind === "new-map") return "map";
  return draft.selection.kind;
}

function draftParent(draft: LibraryDraft, payload: MindMapPayload): string {
  if (draft.kind === "new-folder" || draft.kind === "new-map") return draft.parentPath;
  if (draft.selection.kind === "folder") return parentPath(draft.selection.path);
  const mapId = draft.selection.mapId;
  return parentPath(payload.maps.find((map) => map.id === mapId)?.path ?? "");
}

function hasSibling(
  payload: MindMapPayload,
  parent: string,
  name: string,
  kind: "folder" | "map",
  excluded: Exclude<LibrarySelection, null> | null,
): boolean {
  const key = comparableLibraryName(name, kind);
  if (kind === "folder") {
    return payload.folders.some((path) =>
      parentPath(path) === parent
      && !(excluded?.kind === "folder" && excluded.path === path)
      && comparableLibraryName(baseName(path), "folder") === key);
  }
  return payload.maps.some((map) =>
    parentPath(map.path) === parent
    && !(excluded?.kind === "map" && excluded.mapId === map.id)
    && comparableLibraryName(baseName(map.path), "map") === key);
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function sameEndpoint(left: MindMapEndpoint, right: MindMapEndpoint): boolean {
  return left.nodeId === right.nodeId && left.side === right.side;
}

function retainLibrarySelection(selection: LibrarySelection, payload: MindMapPayload): LibrarySelection {
  if (selection?.kind === "folder") return payload.folders.includes(selection.path) ? selection : null;
  if (selection?.kind === "map") return payload.maps.some((map) => map.id === selection.mapId) ? selection : null;
  return null;
}

function nearestExistingFolder(path: string, payload: MindMapPayload): LibrarySelection {
  let candidate = path;
  while (candidate) {
    if (payload.folders.includes(candidate)) return { kind: "folder", path: candidate };
    candidate = parentPath(candidate);
  }
  return null;
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.matches("input, textarea, [contenteditable='true']");
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
