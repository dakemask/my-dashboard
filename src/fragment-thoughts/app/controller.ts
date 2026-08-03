import {
  ModuleSyncUi,
  type ModuleRuntime,
  type ModuleRuntimeHooks,
  type ModuleRuntimeSnapshot,
  type ModuleSyncAction,
  type ProjectionReason,
  type SettleReason,
} from "../../shared";
import { fragmentThoughtsDefinition } from "../definition";
import {
  createEmptyFragmentThoughtsPayload,
  type FragmentThought,
  type FragmentThoughtsEvent,
  type FragmentThoughtsPayload,
  type FragmentThoughtVersion,
} from "../domain";
import { FragmentThoughtsShell } from "../ui/shell";
import type {
  FragmentThoughtsShellCallbacks,
  ThoughtCardView,
  ThoughtHistoryView,
} from "../ui/types";
import {
  beginEditingDraft,
  completePendingDraftApplication,
  createIdleDraft,
  getDraftGate,
  hasActiveDraft,
  hasEditingChanges,
  reconcileDraftWithPayload,
  setComposerDraft,
  settleDraft,
  updateEditingDraft,
  type DraftSettleResult,
  type FragmentThoughtDraft,
  type PendingDraftApplication,
} from "./drafts";
import { getFragmentThoughtsKeyboardCommand } from "./keyboard";
import {
  projectFragmentThoughts,
  type FragmentThoughtsPresentation,
} from "./presentation";

type FragmentThoughtsRuntime = ModuleRuntime<
  FragmentThoughtsPayload,
  FragmentThoughtsEvent
>;

interface PendingDraftSettlement {
  readonly application: PendingDraftApplication;
  readonly notifyRemoteSettlement: boolean;
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

const BLANK_DRAFT_MESSAGE = "请输入至少一个非空白字符。";
const DRAFT_GATE_MESSAGE =
  "请先保存、清空或取消当前草稿，再执行这项操作。";

export class FragmentThoughtsController {
  readonly hooks: ModuleRuntimeHooks<
    FragmentThoughtsPayload,
    FragmentThoughtsEvent
  >;

  readonly #shell: FragmentThoughtsShell;
  readonly #syncUi: ModuleSyncUi;
  readonly #pageWindow: Window;
  readonly #removeListeners: Array<() => void> = [];
  #runtime: FragmentThoughtsRuntime | null = null;
  #payload = createEmptyFragmentThoughtsPayload();
  #snapshot: ModuleRuntimeSnapshot = EMPTY_SNAPSHOT;
  #draft: FragmentThoughtDraft = createIdleDraft();
  #pendingDraft: PendingDraftSettlement | null = null;
  #searchQuery = "";
  #selectedHistoryId: string | null = null;
  #localSaveFailed = false;
  #disposed = false;

  constructor(appRoot: HTMLElement) {
    const pageWindow = appRoot.ownerDocument.defaultView;
    if (!pageWindow) throw new Error("Fragment Thoughts window is unavailable.");
    this.#pageWindow = pageWindow;
    this.#shell = new FragmentThoughtsShell(appRoot);
    this.#syncUi = new ModuleSyncUi({
      mount: this.#shell.getSyncMount(),
      guardAction: (action) => this.#guardSyncAction(action),
    });
    this.hooks = {
      settle: (reason) => this.#settle(reason),
      project: (payload, reason) => this.#project(payload, reason),
      onSnapshotChange: (snapshot) => this.#onSnapshotChange(snapshot),
    };
    this.#bindUi();
    this.#renderAll();
  }

  attachRuntime(
    runtime: FragmentThoughtsRuntime,
    initialPayload: FragmentThoughtsPayload,
  ): void {
    this.#assertAlive();
    this.#runtime = runtime;
    this.#payload = initialPayload;
    this.#snapshot = runtime.getSnapshot();
    this.#syncUi.attachRuntime(runtime);
    this.#renderAll();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const remove of this.#removeListeners.splice(0)) remove();
    this.#syncUi.dispose();
    this.#shell.dispose();
    const runtime = this.#runtime;
    this.#runtime = null;
    await runtime?.dispose();
  }

  #bindUi(): void {
    const callbacks: FragmentThoughtsShellCallbacks = {
      onComposerInput: (value) => this.#onComposerInput(value),
      onComposerSubmit: (value) => {
        this.#onComposerInput(value);
        void this.#createThought();
      },
      onComposerClear: () => void this.#clearComposer(),
      onSearchInput: (value) => {
        this.#searchQuery = value;
        this.#renderContent();
      },
      onSearchClear: () => {
        this.#searchQuery = "";
        this.#shell.setSearchValue("");
        this.#renderContent();
        this.#shell.focusSearch();
      },
      onRetrySave: () => void this.#retryLocalSave(),
      onEditThought: (thoughtId) => this.#beginEdit(thoughtId),
      onEditInput: (thoughtId, value) => {
        this.#draft = updateEditingDraft(this.#draft, thoughtId, value);
        this.#shell.setEditError(thoughtId, null);
        this.#renderDraftState();
      },
      onSaveEdit: (thoughtId, value) => {
        this.#draft = updateEditingDraft(this.#draft, thoughtId, value);
        void this.#saveEdit(thoughtId);
      },
      onCancelEdit: (thoughtId) => void this.#cancelEdit(thoughtId),
      onDeleteThought: (thoughtId) => void this.#deleteThought(thoughtId),
      onToggleHistory: (thoughtId) => this.#toggleHistory(thoughtId),
      onOpenMatchingHistory: (thoughtId) => this.#openMatchingHistory(thoughtId),
      onCloseHistory: () => {
        this.#selectedHistoryId = null;
        this.#renderContent();
      },
      onToggleHistoryVersion: (thoughtId, versionId) => {
        void this.#toggleVersionCollapsed(thoughtId, versionId);
      },
    };
    this.#removeListeners.push(this.#shell.bindCallbacks(callbacks));
    this.#listen(this.#pageWindow.document, "keydown", (event) => {
      this.#onKeyDown(event as KeyboardEvent);
    }, true);
    this.#listen(this.#pageWindow, "beforeunload", (event) => {
      this.#onBeforeUnload(event as BeforeUnloadEvent);
    });
  }

  #onComposerInput(value: string): void {
    this.#draft = setComposerDraft(this.#draft, value);
    this.#renderDraftState();
  }

  #project(
    payload: FragmentThoughtsPayload,
    _reason: ProjectionReason,
  ): void {
    this.#payload = payload;
    this.#draft = reconcileDraftWithPayload(this.#draft, payload);
    this.#pendingDraft = null;
    this.#renderAll();
  }

  #settle(reason: SettleReason): FragmentThoughtsEvent | null {
    if (reason !== "remote-change") return null;
    const settlement = this.#settleCurrentDraft("remote-change");
    this.#draft = settlement.draft;
    if (settlement.status !== "ready") {
      if (settlement.status !== "no-change") this.#renderAll();
      return null;
    }

    this.#pendingDraft = {
      application: settlement.pending,
      notifyRemoteSettlement: true,
    };
    this.#renderDraftState();
    return settlement.event;
  }

  #onSnapshotChange(snapshot: ModuleRuntimeSnapshot): void {
    this.#snapshot = snapshot;
    const runtime = this.#runtime;
    let contentChanged = false;
    if (runtime?.state === "ready") {
      const current = runtime.current;
      contentChanged = contentKey(current) !== contentKey(this.#payload);
      if (contentChanged) this.#payload = current;
    }

    const pendingCompleted = this.#completePendingDraft();
    if (!snapshot.sessionDirty) this.#localSaveFailed = false;
    if (contentChanged || pendingCompleted) this.#renderContent();
    this.#renderSnapshot();
    this.#renderDraftState();
  }

  #completePendingDraft(): boolean {
    const pending = this.#pendingDraft;
    if (!pending) return false;
    const completed = completePendingDraftApplication(
      this.#draft,
      pending.application,
      this.#payload,
    );
    if (!completed.applied) return false;

    this.#draft = completed.draft;
    this.#pendingDraft = null;
    if (pending.notifyRemoteSettlement) {
      this.#shell.showMessage(
        "检测到云端变化，当前草稿已先保存到本机，请选择上传或拉取。",
        "normal",
      );
    }
    return true;
  }

  async #createThought(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || this.#draft.kind === "editing") return;
    const settlement = this.#settleCurrentDraft("manual");
    this.#draft = settlement.draft;
    if (settlement.status === "invalid") {
      this.#renderDraftState();
      this.#shell.focusComposer();
      return;
    }
    if (settlement.status !== "ready") {
      this.#renderAll();
      return;
    }

    try {
      this.#payload = runtime.dispatch(settlement.event);
    } catch {
      this.#renderAll();
      this.#shell.showMessage("想法未能保存，请稍后重试。", "error", 6200);
      return;
    }
    this.#completeManualDraft(settlement);
    this.#renderAll();
    await this.#saveAfterMutation("想法已保存到本机。");
    this.#shell.focusComposer();
  }

  async #clearComposer(): Promise<void> {
    if (this.#draft.kind !== "composer") return;
    const choice = await this.#shell.choose(
      "清空当前草稿？",
      "尚未保存的文字会被丢弃。",
      [
        { id: "cancel", label: "取消" },
        { id: "clear", label: "清空草稿", tone: "danger" },
      ],
    );
    if (choice !== "clear") return;
    this.#draft = createIdleDraft();
    this.#renderDraftState();
    this.#shell.focusComposer();
  }

  #beginEdit(thoughtId: string): void {
    if (!this.#runtime) return;
    if (getDraftGate(this.#draft).status === "blocked") {
      this.#showDraftGateMessage();
      return;
    }
    const thought = this.#findThought(thoughtId);
    if (!thought) return;
    this.#draft = beginEditingDraft(this.#draft, thought);
    this.#renderAll();
    this.#shell.focusEditor(thoughtId);
  }

  async #saveEdit(thoughtId: string): Promise<void> {
    const runtime = this.#runtime;
    if (
      !runtime
      || this.#draft.kind !== "editing"
      || this.#draft.thoughtId !== thoughtId
    ) {
      return;
    }

    const settlement = this.#settleCurrentDraft("manual");
    this.#draft = settlement.draft;
    if (settlement.status === "invalid") {
      this.#shell.setEditError(thoughtId, BLANK_DRAFT_MESSAGE);
      this.#renderDraftState();
      this.#shell.focusEditor(thoughtId);
      return;
    }
    if (settlement.status === "discarded") {
      this.#renderAll();
      if (settlement.reason === "unchanged") {
        this.#shell.showMessage("内容没有变化。");
      }
      return;
    }
    if (settlement.status !== "ready") return;

    try {
      this.#payload = runtime.dispatch(settlement.event);
    } catch {
      this.#renderAll();
      this.#shell.showMessage("修改未能保存，请稍后重试。", "error", 6200);
      return;
    }
    this.#completeManualDraft(settlement);
    this.#renderAll();
    await this.#saveAfterMutation("修改已保存到本机。");
  }

  async #cancelEdit(thoughtId: string): Promise<void> {
    if (
      this.#draft.kind !== "editing"
      || this.#draft.thoughtId !== thoughtId
    ) {
      return;
    }
    if (hasEditingChanges(this.#draft)) {
      const choice = await this.#shell.choose(
        "放弃这次修改？",
        "尚未保存的编辑内容会被丢弃。",
        [
          { id: "cancel", label: "继续编辑" },
          { id: "discard", label: "放弃修改", tone: "danger" },
        ],
      );
      if (choice !== "discard") {
        this.#shell.focusEditor(thoughtId);
        return;
      }
    }
    this.#draft = createIdleDraft();
    this.#renderAll();
  }

  async #deleteThought(thoughtId: string): Promise<void> {
    if (getDraftGate(this.#draft).status === "blocked") {
      this.#showDraftGateMessage();
      return;
    }
    const runtime = this.#runtime;
    const thought = this.#findThought(thoughtId);
    if (!runtime || !thought) return;
    const choice = await this.#shell.choose(
      "永久删除这条想法？",
      "这条想法及其全部历史版本都会被删除。",
      [
        { id: "cancel", label: "取消" },
        { id: "delete", label: "删除", tone: "danger" },
      ],
    );
    if (choice !== "delete") return;

    try {
      this.#payload = runtime.dispatch({ type: "delete-thought", thoughtId });
    } catch {
      this.#shell.showMessage("删除未能完成，请稍后重试。", "error", 6200);
      return;
    }
    if (this.#selectedHistoryId === thoughtId) this.#selectedHistoryId = null;
    this.#renderAll();
    await this.#saveAfterMutation("想法已删除并保存到本机。");
  }

  #toggleHistory(thoughtId: string): void {
    if (!this.#findThought(thoughtId)) return;
    this.#selectedHistoryId = this.#selectedHistoryId === thoughtId
      ? null
      : thoughtId;
    this.#renderContent();
    if (this.#selectedHistoryId) this.#shell.focusHistoryClose();
  }

  #openMatchingHistory(thoughtId: string): void {
    if (!this.#findThought(thoughtId)) return;
    this.#selectedHistoryId = thoughtId;
    this.#renderContent();
    if (this.#selectedHistoryId) this.#shell.focusHistoryClose();
  }

  async #toggleVersionCollapsed(
    thoughtId: string,
    versionId: string,
  ): Promise<void> {
    if (getDraftGate(this.#draft).status === "blocked") {
      this.#showDraftGateMessage();
      return;
    }
    const presentation = projectFragmentThoughts(this.#payload, {
      query: this.#searchQuery,
      selectedHistoryId: thoughtId,
    });
    const projectedVersion = presentation.history?.versions.find(
      (version) => version.version.id === versionId,
    );
    if (projectedVersion?.collapseLocked) {
      this.#shell.showMessage(
        "搜索命中的版本会保持展开；清除搜索后可以折叠。",
      );
      return;
    }
    const runtime = this.#runtime;
    const thought = this.#findThought(thoughtId);
    if (
      !runtime
      || !thought
      || !thought.versions.some((version) => version.id === versionId)
    ) {
      return;
    }

    try {
      this.#payload = runtime.dispatch({
        type: "set-version-collapsed",
        thoughtId,
        versionId,
        collapsed: !thought.collapsedVersionIds.includes(versionId),
      });
    } catch {
      this.#shell.showMessage("折叠状态未能保存，请稍后重试。", "error", 6200);
      return;
    }
    this.#renderContent();
    await this.#saveAfterMutation(null);
  }

  async #retryLocalSave(): Promise<void> {
    if (getDraftGate(this.#draft).status === "blocked") {
      this.#showDraftGateMessage();
      return;
    }
    const runtime = this.#runtime;
    if (!runtime) return;
    try {
      await runtime.save();
      this.#localSaveFailed = false;
      this.#renderSnapshot();
      this.#shell.showMessage("已重新保存到本机。", "success");
    } catch {
      this.#markSaveFailure();
    }
  }

  async #saveAfterMutation(successMessage: string | null): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) return;
    try {
      await runtime.save();
      this.#localSaveFailed = false;
      this.#renderSnapshot();
      if (successMessage) this.#shell.showMessage(successMessage, "success");
    } catch {
      this.#markSaveFailure();
    }
  }

  #markSaveFailure(): void {
    this.#localSaveFailed = true;
    this.#renderSnapshot();
    this.#shell.showMessage(
      "自动保存到本机失败，当前页面内容仍然保留。",
      "error",
      6200,
    );
  }

  #guardSyncAction(
    _action: ModuleSyncAction,
  ):
    | { readonly status: "ready" }
    | { readonly status: "blocked"; readonly message: string } {
    return getDraftGate(this.#draft).status === "blocked"
      ? {
          status: "blocked",
          message: "请先保存、清空或取消当前草稿，再执行同步操作。",
        }
      : { status: "ready" };
  }

  #onKeyDown(event: KeyboardEvent): void {
    const command = getFragmentThoughtsKeyboardCommand(event);
    if (command === null) return;
    event.preventDefault();
    if (getDraftGate(this.#draft).status === "blocked") {
      this.#showDraftGateMessage();
      return;
    }
    if (command === "undo") void this.#undo();
    else void this.#redo();
  }

  async #undo(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || !runtime.canUndo) return;
    try {
      this.#payload = await runtime.undo();
      this.#draft = reconcileDraftWithPayload(this.#draft, this.#payload);
      this.#renderAll();
      await this.#saveAfterMutation("已撤销并保存到本机。");
    } catch {
      this.#shell.showMessage("撤销未能完成，请稍后重试。", "error", 6200);
    }
  }

  async #redo(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || !runtime.canRedo) return;
    try {
      this.#payload = await runtime.redo();
      this.#draft = reconcileDraftWithPayload(this.#draft, this.#payload);
      this.#renderAll();
      await this.#saveAfterMutation("已重做并保存到本机。");
    } catch {
      this.#shell.showMessage("重做未能完成，请稍后重试。", "error", 6200);
    }
  }

  #onBeforeUnload(event: BeforeUnloadEvent): void {
    if (
      !hasActiveDraft(this.#draft)
      && !this.#snapshot.sessionDirty
      && !this.#localSaveFailed
    ) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  }

  #renderAll(): void {
    this.#renderSnapshot();
    this.#renderContent();
    this.#renderDraftState();
  }

  #renderSnapshot(): void {
    this.#syncUi.renderSnapshot(this.#snapshot);
    this.#syncUi.setLocalSaveFailed(this.#localSaveFailed);
    this.#shell.setSaveFailure(
      this.#localSaveFailed
        ? "自动保存失败，当前页面内容仍然保留。"
        : null,
    );
  }

  #renderContent(): void {
    const presentation = projectFragmentThoughts(this.#payload, {
      query: this.#searchQuery,
      selectedHistoryId: this.#selectedHistoryId,
    });
    this.#selectedHistoryId = presentation.selectedHistoryId;
    this.#renderThoughts(presentation);
    this.#renderHistory(presentation);
  }

  #renderThoughts(presentation: FragmentThoughtsPresentation): void {
    const draftPresent = hasActiveDraft(this.#draft);
    const editingDraft = this.#draft.kind === "editing" ? this.#draft : null;
    const views: ThoughtCardView[] = presentation.thoughts.map((item) => {
      const editing = editingDraft?.thoughtId === item.thought.id;
      return {
        id: item.thought.id,
        content: item.current.version.content,
        modifiedAt: item.current.version.createdAt,
        historyMatchCount: item.historicalVersionMatchCount,
        highlightRanges: item.current.matchRanges,
        editing,
        editDraft: editing ? editingDraft.value : undefined,
        editError: editing && editingDraft.error === "blank"
          ? BLANK_DRAFT_MESSAGE
          : null,
        historyOpen: presentation.selectedHistoryId === item.thought.id,
        mutationsDisabled: draftPresent || this.#runtime === null,
      };
    });
    this.#shell.renderThoughts(
      views,
      this.#payload.thoughts.length === 0
        ? "还没有想法。先记录第一条吧。"
        : "没有找到匹配的想法。",
      this.#payload.thoughts.map((thought) => thought.id),
    );
    this.#shell.setSearchStatus(
      presentation.query.length === 0
        ? null
        : `找到 ${views.length} 条匹配的想法。`,
    );
  }

  #renderHistory(presentation: FragmentThoughtsPresentation): void {
    const history = presentation.history;
    if (!history) {
      this.#shell.setHistoryOpen(false);
      this.#shell.renderHistory(null);
      return;
    }

    const view: ThoughtHistoryView = {
      thoughtId: history.thoughtId,
      versions: history.versions.map((version) => ({
        id: version.version.id,
        content: version.version.content,
        createdAt: version.version.createdAt,
        collapsed: version.collapsed,
        collapseLockedMessage: version.collapseLocked
          ? "搜索命中的版本会保持展开；清除搜索后可以折叠。"
          : undefined,
        highlightRanges: version.matchRanges,
      })),
    };
    this.#shell.setHistoryOpen(true);
    this.#shell.renderHistory(view);
  }

  #renderDraftState(): void {
    const editing = this.#draft.kind === "editing";
    const composerValue = this.#draft.kind === "composer"
      ? this.#draft.value
      : "";
    const composerError = this.#draft.kind === "idle"
      ? this.#draft.composerError
      : this.#draft.kind === "composer"
        ? this.#draft.error
        : null;
    this.#shell.setComposerValue(composerValue);
    this.#shell.setComposerError(
      composerError === "blank" ? BLANK_DRAFT_MESSAGE : null,
    );
    this.#shell.setComposerEnabled(this.#runtime !== null && !editing);
    this.#shell.setMutationLocked(
      hasActiveDraft(this.#draft) || this.#runtime === null,
    );
    this.#shell.setHistoryCollapseDraftLocked(hasActiveDraft(this.#draft));
    this.#shell.setDraftNotice(
      editing
        ? "正在编辑想法。请先保存或取消修改，再执行其他数据操作。"
        : this.#draft.kind === "composer"
          ? "有尚未提交的新增草稿。请先保存或清空，再执行其他数据操作。"
          : null,
    );
  }

  #settleCurrentDraft(
    reason: "manual" | "remote-change",
  ): DraftSettleResult {
    return settleDraft(this.#draft, this.#payload, {
      reason,
      createThought: (content) => this.#buildThought(content),
      createVersion: (content, thought) =>
        this.#createVersion(content, thought),
    });
  }

  #completeManualDraft(
    settlement: Extract<DraftSettleResult, { readonly status: "ready" }>,
  ): void {
    const completed = completePendingDraftApplication(
      settlement.draft,
      settlement.pending,
      this.#payload,
    );
    this.#draft = completed.draft;
    this.#pendingDraft = completed.pending
      ? {
          application: completed.pending,
          notifyRemoteSettlement: false,
        }
      : null;
  }

  #showDraftGateMessage(): void {
    this.#shell.showMessage(DRAFT_GATE_MESSAGE);
  }

  #buildThought(content: string): FragmentThought {
    const thoughtId = this.#createUniqueId();
    return {
      id: thoughtId,
      versions: [this.#createVersion(content, undefined, new Set([thoughtId]))],
      collapsedVersionIds: [],
    };
  }

  #createVersion(
    content: string,
    thought?: FragmentThought,
    reservedIds: ReadonlySet<string> = new Set(),
  ): FragmentThoughtVersion {
    const lastTimestamp = thought
      ? Date.parse(latestVersion(thought).createdAt)
      : Number.NEGATIVE_INFINITY;
    const timestamp = Math.max(Date.now(), lastTimestamp + 1);
    return {
      id: this.#createUniqueId(reservedIds),
      content,
      createdAt: new Date(timestamp).toISOString(),
    };
  }

  #createUniqueId(reservedIds: ReadonlySet<string> = new Set()): string {
    const existing = new Set<string>();
    for (const thought of this.#payload.thoughts) {
      existing.add(thought.id);
      for (const version of thought.versions) existing.add(version.id);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.#pageWindow.crypto.randomUUID().toLowerCase();
      if (!existing.has(id) && !reservedIds.has(id)) return id;
    }
    throw new Error("Unable to generate a unique Fragment Thought id.");
  }

  #findThought(thoughtId: string): FragmentThought | null {
    return this.#payload.thoughts.find(
      (thought) => thought.id === thoughtId,
    ) ?? null;
  }

  #listen(
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
    capture = false,
  ): void {
    target.addEventListener(type, listener, capture);
    this.#removeListeners.push(() => {
      target.removeEventListener(type, listener, capture);
    });
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("Fragment Thoughts controller is disposed.");
  }
}

function latestVersion(thought: FragmentThought): FragmentThoughtVersion {
  const version = thought.versions.at(-1);
  if (!version) throw new TypeError("A Fragment Thought has no versions.");
  return version;
}

function contentKey(payload: FragmentThoughtsPayload): string {
  return fragmentThoughtsDefinition.contentKey(payload);
}
