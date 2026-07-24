import {
  type ModuleRuntime,
  type ModuleRuntimeHooks,
  type ModuleRuntimeSnapshot,
  type ProjectionReason,
  type SettleReason,
  type SyncActionResult,
} from "../../shared";
import { fragmentThoughtsDefinition } from "../definition";
import {
  createEmptyFragmentThoughtsPayload,
  normalizeFragmentThoughtContent,
  type FragmentThought,
  type FragmentThoughtsEvent,
  type FragmentThoughtsPayload,
  type FragmentThoughtVersion,
} from "../domain";
import {
  FragmentThoughtsShell,
  type ThoughtCardView,
  type ThoughtHistoryView,
} from "../ui/shell";

type FragmentThoughtsRuntime = ModuleRuntime<
  FragmentThoughtsPayload,
  FragmentThoughtsEvent
>;

interface EditingState {
  readonly thoughtId: string;
  readonly original: string;
  draft: string;
  error: string | null;
}

type PendingRemoteSettle =
  | { readonly kind: "insert"; readonly thoughtId: string }
  | {
      readonly kind: "edit";
      readonly thoughtId: string;
      readonly versionId: string;
    };

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

export class FragmentThoughtsController {
  readonly hooks: ModuleRuntimeHooks<
    FragmentThoughtsPayload,
    FragmentThoughtsEvent
  >;

  readonly #shell: FragmentThoughtsShell;
  readonly #pageWindow: Window;
  readonly #removeListeners: Array<() => void> = [];
  #runtime: FragmentThoughtsRuntime | null = null;
  #payload = createEmptyFragmentThoughtsPayload();
  #snapshot: ModuleRuntimeSnapshot = EMPTY_SNAPSHOT;
  #editing: EditingState | null = null;
  #selectedHistoryId: string | null = null;
  #pendingRemoteSettle: PendingRemoteSettle | null = null;
  #localSaveFailed = false;
  #disposed = false;

  constructor(appRoot: HTMLElement) {
    const pageWindow = appRoot.ownerDocument.defaultView;
    if (!pageWindow) throw new Error("Fragment Thoughts window is unavailable.");
    this.#pageWindow = pageWindow;
    this.#shell = new FragmentThoughtsShell(appRoot);
    this.#shell.elements.homeLink.href = import.meta.env.BASE_URL;
    this.hooks = {
      settle: (reason) => this.#settle(reason),
      project: (payload, reason) => this.#project(payload, reason),
      onConflict: () => {
        this.#shell.showMessage(
          "本地与云端都已变化，请通过上传或拉取选择保留方向。",
          "error",
          6200,
        );
      },
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
    this.#renderAll();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const remove of this.#removeListeners.splice(0)) remove();
    this.#shell.dispose();
    const runtime = this.#runtime;
    this.#runtime = null;
    await runtime?.dispose();
  }

  #bindUi(): void {
    const elements = this.#shell.elements;
    this.#listen(elements.composerForm, "submit", (event) => {
      event.preventDefault();
      void this.#createThought();
    });
    this.#listen(elements.composerInput, "input", () => {
      this.#shell.setComposerError(null);
      this.#renderDraftState();
      this.#updateRenderedMutationButtons();
    });
    this.#listen(elements.composerClearButton, "click", () => {
      void this.#clearComposer();
    });
    this.#listen(elements.searchInput, "input", () => {
      this.#retainVisibleHistorySelection();
      this.#renderThoughts();
      this.#renderHistory();
    });
    this.#listen(elements.searchClearButton, "click", () => {
      this.#shell.setSearchValue("");
      this.#renderThoughts();
      this.#renderHistory();
      elements.searchInput.focus();
    });
    this.#listen(elements.thoughtList, "input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      if (target.dataset.role !== "edit-input") return;
      if (!this.#editing || target.dataset.thoughtId !== this.#editing.thoughtId) {
        return;
      }
      this.#editing.draft = target.value;
      this.#editing.error = null;
      target.setAttribute("aria-invalid", "false");
      const error = target.parentElement?.querySelector<HTMLElement>(".ft-field-error");
      if (error) {
        error.textContent = "";
        error.hidden = true;
      }
      this.#renderDraftState();
    });
    this.#listen(elements.thoughtList, "click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest<HTMLButtonElement>("button[data-action]");
      if (!action || action.disabled) return;
      const thoughtId = action.dataset.thoughtId;
      if (!thoughtId) return;
      switch (action.dataset.action) {
        case "delete-thought":
          void this.#deleteThought(thoughtId);
          break;
        case "edit-thought":
          this.#beginEdit(thoughtId);
          break;
        case "toggle-history":
          this.#toggleHistory(thoughtId);
          break;
        case "open-history-match":
          this.#openMatchingHistory(thoughtId);
          break;
        case "save-edit":
          void this.#saveEdit(thoughtId);
          break;
        case "cancel-edit":
          void this.#cancelEdit(thoughtId);
          break;
      }
    });
    this.#listen(elements.historyCloseButton, "click", () => {
      this.#selectedHistoryId = null;
      this.#renderThoughts();
      this.#renderHistory();
    });
    this.#listen(elements.historyList, "click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest<HTMLButtonElement>(
        'button[data-action="toggle-history-version"]',
      );
      if (!action) return;
      const lockedMessage = action.dataset.lockedMessage;
      if (lockedMessage) {
        this.#shell.showMessage(lockedMessage);
        return;
      }
      const thoughtId = action.dataset.thoughtId;
      const versionId = action.dataset.versionId;
      if (!thoughtId || !versionId) return;
      void this.#toggleVersionCollapsed(thoughtId, versionId);
    });
    this.#listen(elements.retrySaveButton, "click", () => {
      void this.#retryLocalSave();
    });
    this.#listen(elements.uploadButton, "click", () => {
      void this.#upload();
    });
    this.#listen(elements.pullButton, "click", () => {
      void this.#pull();
    });
    this.#listen(this.#pageWindow.document, "keydown", (event) => {
      this.#onKeyDown(event as KeyboardEvent);
    }, true);
    this.#listen(this.#pageWindow, "beforeunload", (event) => {
      this.#onBeforeUnload(event as BeforeUnloadEvent);
    });
  }

  #project(
    payload: FragmentThoughtsPayload,
    _reason: ProjectionReason,
  ): void {
    this.#payload = payload;
    this.#editing = null;
    this.#pendingRemoteSettle = null;
    this.#reconcileLiveState();
    this.#renderAll();
  }

  #settle(reason: SettleReason): FragmentThoughtsEvent | null {
    if (reason !== "remote-change") return null;

    if (this.#editing) {
      const editing = this.#editing;
      const thought = this.#findThought(editing.thoughtId);
      const content = normalizeDraft(editing.draft);
      if (!thought || content === null) {
        this.#editing = null;
        this.#renderAll();
        return null;
      }
      if (content === latestVersion(thought).content) {
        this.#editing = null;
        this.#renderAll();
        return null;
      }
      const version = this.#createVersion(content, thought);
      this.#pendingRemoteSettle = {
        kind: "edit",
        thoughtId: thought.id,
        versionId: version.id,
      };
      return {
        type: "append-version",
        thoughtId: thought.id,
        version,
        collapsed: false,
      };
    }

    const rawDraft = this.#shell.elements.composerInput.value;
    if (rawDraft.length === 0) return null;
    const content = normalizeDraft(rawDraft);
    if (content === null) {
      this.#shell.setComposerValue("");
      this.#shell.setComposerError(null);
      this.#renderDraftState();
      this.#updateRenderedMutationButtons();
      return null;
    }
    const thought = this.#buildThought(content);
    this.#pendingRemoteSettle = {
      kind: "insert",
      thoughtId: thought.id,
    };
    return { type: "insert-thought", thought };
  }

  #onSnapshotChange(snapshot: ModuleRuntimeSnapshot): void {
    this.#snapshot = snapshot;
    const runtime = this.#runtime;
    let payloadChanged = false;
    if (runtime?.state === "ready") {
      const current = runtime.current;
      payloadChanged = contentKey(current) !== contentKey(this.#payload);
      if (payloadChanged) this.#payload = current;
    }
    if (!snapshot.sessionDirty) this.#localSaveFailed = false;
    if (this.#completePendingRemoteSettle()) payloadChanged = true;
    if (payloadChanged) {
      this.#reconcileLiveState();
      this.#renderThoughts();
      this.#renderHistory();
    }
    this.#renderSnapshot();
    this.#renderDraftState();
    this.#updateRenderedMutationButtons();
  }

  #completePendingRemoteSettle(): boolean {
    const pending = this.#pendingRemoteSettle;
    if (!pending) return false;
    const thought = this.#findThought(pending.thoughtId);
    const applied = pending.kind === "insert"
      ? Boolean(thought)
      : thought?.versions.at(-1)?.id === pending.versionId;
    if (!applied) return false;

    this.#pendingRemoteSettle = null;
    if (pending.kind === "insert") {
      this.#shell.setComposerValue("");
      this.#shell.setComposerError(null);
    } else {
      this.#editing = null;
    }
    this.#shell.showMessage(
      "检测到云端变化，当前草稿已先保存到本机，请选择上传或拉取。",
      "normal",
      6200,
    );
    return true;
  }

  async #createThought(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || this.#editing) return;
    const content = normalizeDraft(this.#shell.elements.composerInput.value);
    if (content === null) {
      this.#shell.setComposerError("请输入至少一个非空白字符。");
      this.#shell.elements.composerInput.focus();
      return;
    }
    const thought = this.#buildThought(content);
    try {
      this.#payload = runtime.dispatch({ type: "insert-thought", thought });
    } catch {
      this.#shell.showMessage("想法未能保存，请稍后重试。", "error");
      return;
    }
    this.#shell.setComposerValue("");
    this.#shell.setComposerError(null);
    this.#renderAll();
    await this.#saveAfterMutation("想法已保存到本机。");
    this.#shell.elements.composerInput.focus();
  }

  async #clearComposer(): Promise<void> {
    const input = this.#shell.elements.composerInput;
    if (input.value.length === 0) return;
    const choice = await this.#shell.choose(
      "清空当前草稿？",
      "尚未保存的文字会被丢弃。",
      [
        { id: "clear", label: "清空草稿", tone: "danger" },
        { id: "cancel", label: "取消" },
      ],
    );
    if (choice !== "clear") return;
    this.#shell.setComposerValue("");
    this.#shell.setComposerError(null);
    this.#renderDraftState();
    this.#updateRenderedMutationButtons();
    input.focus();
  }

  #beginEdit(thoughtId: string): void {
    if (this.#hasDraft() || !this.#runtime) {
      this.#showDraftGateMessage();
      return;
    }
    const thought = this.#findThought(thoughtId);
    if (!thought) return;
    const content = latestVersion(thought).content;
    this.#editing = {
      thoughtId,
      original: content,
      draft: content,
      error: null,
    };
    this.#renderAll();
    this.#pageWindow.queueMicrotask(() => {
      const editor = this.#shell.elements.thoughtList.querySelector<HTMLTextAreaElement>(
        `textarea[data-role="edit-input"][data-thought-id="${thoughtId}"]`,
      );
      editor?.focus();
      editor?.setSelectionRange(editor.value.length, editor.value.length);
    });
  }

  async #saveEdit(thoughtId: string): Promise<void> {
    const runtime = this.#runtime;
    const editing = this.#editing;
    const thought = this.#findThought(thoughtId);
    if (!runtime || !editing || editing.thoughtId !== thoughtId || !thought) return;
    const content = normalizeDraft(editing.draft);
    if (content === null) {
      editing.error = "请输入至少一个非空白字符。";
      this.#renderThoughts();
      this.#focusEditor(thoughtId);
      return;
    }
    if (content === latestVersion(thought).content) {
      this.#editing = null;
      this.#renderAll();
      this.#shell.showMessage("内容没有变化。");
      return;
    }

    const previousEditing = editing;
    const version = this.#createVersion(content, thought);
    this.#editing = null;
    try {
      this.#payload = runtime.dispatch({
        type: "append-version",
        thoughtId,
        version,
        collapsed: false,
      });
    } catch {
      this.#editing = previousEditing;
      this.#renderAll();
      this.#shell.showMessage("修改未能保存，请稍后重试。", "error");
      return;
    }
    this.#renderAll();
    await this.#saveAfterMutation("修改已保存到本机。");
  }

  async #cancelEdit(thoughtId: string): Promise<void> {
    const editing = this.#editing;
    if (!editing || editing.thoughtId !== thoughtId) return;
    if (editing.draft !== editing.original) {
      const choice = await this.#shell.choose(
        "放弃这次修改？",
        "尚未保存的编辑内容会被丢弃。",
        [
          { id: "discard", label: "放弃修改", tone: "danger" },
          { id: "cancel", label: "继续编辑" },
        ],
      );
      if (choice !== "discard") {
        this.#focusEditor(thoughtId);
        return;
      }
    }
    this.#editing = null;
    this.#renderAll();
  }

  async #deleteThought(thoughtId: string): Promise<void> {
    if (this.#hasDraft()) {
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
        { id: "delete", label: "删除", tone: "danger" },
        { id: "cancel", label: "取消" },
      ],
    );
    if (choice !== "delete") return;
    try {
      this.#payload = runtime.dispatch({ type: "delete-thought", thoughtId });
    } catch {
      this.#shell.showMessage("删除未能完成，请稍后重试。", "error");
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
    this.#renderThoughts();
    this.#renderHistory();
    if (this.#selectedHistoryId) {
      this.#pageWindow.queueMicrotask(() => {
        this.#shell.elements.historyCloseButton.focus();
      });
    }
  }

  #openMatchingHistory(thoughtId: string): void {
    const thought = this.#findThought(thoughtId);
    if (!thought) return;
    this.#selectedHistoryId = thoughtId;
    this.#renderThoughts();
    this.#renderHistory();
    this.#pageWindow.queueMicrotask(() => {
      this.#shell.elements.historyCloseButton.focus();
    });
  }

  async #toggleVersionCollapsed(
    thoughtId: string,
    versionId: string,
  ): Promise<void> {
    if (this.#hasDraft()) {
      this.#showDraftGateMessage();
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
      this.#shell.showMessage("折叠状态未能保存，请稍后重试。", "error");
      return;
    }
    this.#renderHistory();
    await this.#saveAfterMutation(null);
  }

  async #retryLocalSave(): Promise<void> {
    if (this.#hasDraft()) {
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

  async #upload(): Promise<void> {
    if (this.#hasDraft()) {
      this.#showDraftGateMessage();
      return;
    }
    const runtime = this.#runtime;
    if (!runtime) return;
    try {
      let result: SyncActionResult;
      let overwriteConfirmed = false;
      if (runtime.getSnapshot().conflict) {
        if (!await this.#confirmLocalWins()) return;
        overwriteConfirmed = true;
        result = await runtime.resolveConflict("local-wins");
      } else {
        result = await runtime.upload();
      }
      if (result === "conflict" && !overwriteConfirmed) {
        if (!await this.#confirmLocalWins()) return;
        result = await runtime.resolveConflict("local-wins");
      }
      if (result === "conflict") {
        this.#shell.showMessage(
          "覆盖期间云端再次变化，请检查版本后重试。",
          "error",
        );
        return;
      }
      this.#localSaveFailed = false;
      this.#renderSnapshot();
      this.#shell.showMessage(
        result === "unchanged" ? "云端内容已经是最新版本。" : "已上传到云端。",
        "success",
      );
    } catch {
      this.#shell.showMessage("上传失败；本机内容仍然保留。", "error");
    }
  }

  async #pull(): Promise<void> {
    if (this.#hasDraft()) {
      this.#showDraftGateMessage();
      return;
    }
    const runtime = this.#runtime;
    if (!runtime) return;
    try {
      const snapshot = runtime.getSnapshot();
      const needsChoice = Boolean(
        snapshot.conflict
        || snapshot.sessionDirty
        || snapshot.localChangedSinceSync,
      );
      if (needsChoice) {
        if (!await this.#confirmCloudWins()) return;
        await runtime.resolveConflict("cloud-wins");
        return;
      }
      const result = await runtime.pull();
      if (result === "conflict") {
        if (!await this.#confirmCloudWins()) return;
        await runtime.resolveConflict("cloud-wins");
      } else if (result === "unchanged") {
        this.#shell.showMessage("本机已经是已知的最新云端版本。");
      }
    } catch {
      this.#shell.showMessage("拉取失败；本机内容没有被覆盖。", "error");
    }
  }

  async #confirmLocalWins(): Promise<boolean> {
    return await this.#shell.choose(
      "用本地版本覆盖云端？",
      "本地和云端都已变化。继续会以本地全部碎片想法及历史版本覆盖云端。",
      [
        { id: "local-wins", label: "本地覆盖云端", tone: "danger" },
        { id: "cancel", label: "取消" },
      ],
    ) === "local-wins";
  }

  async #confirmCloudWins(): Promise<boolean> {
    return await this.#shell.choose(
      "用云端版本覆盖本地？",
      "继续会丢弃尚未上传的本地变化，并以云端全部碎片想法及历史版本替换本机。",
      [
        { id: "cloud-wins", label: "云端覆盖本地", tone: "danger" },
        { id: "cancel", label: "取消" },
      ],
    ) === "cloud-wins";
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (
      event.defaultPrevented
      || !event.ctrlKey
      || event.metaKey
      || event.altKey
      || event.shiftKey
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    if (this.#hasDraft()) {
      this.#showDraftGateMessage();
      return;
    }
    if (key === "z") void this.#undo();
    else void this.#redo();
  }

  async #undo(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || !runtime.canUndo) return;
    try {
      this.#payload = await runtime.undo();
      this.#reconcileLiveState();
      this.#renderAll();
      await this.#saveAfterMutation("已撤销并保存到本机。");
    } catch {
      this.#shell.showMessage("撤销未能完成，请稍后重试。", "error");
    }
  }

  async #redo(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || !runtime.canRedo) return;
    try {
      this.#payload = await runtime.redo();
      this.#reconcileLiveState();
      this.#renderAll();
      await this.#saveAfterMutation("已重做并保存到本机。");
    } catch {
      this.#shell.showMessage("重做未能完成，请稍后重试。", "error");
    }
  }

  #onBeforeUnload(event: BeforeUnloadEvent): void {
    if (
      !this.#hasDraft()
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
    this.#renderDraftState();
    this.#renderThoughts();
    this.#renderHistory();
  }

  #renderSnapshot(): void {
    this.#shell.renderSnapshot(this.#snapshot);
    this.#shell.setSaveFailure(
      this.#localSaveFailed
        ? "自动保存失败，当前页面内容仍然保留。"
        : null,
    );
  }

  #renderDraftState(): void {
    const composerHasDraft = this.#shell.elements.composerInput.value.length > 0;
    const editing = this.#editing !== null;
    const hasDraft = composerHasDraft || editing;
    this.#shell.setDraftNotice(
      editing
        ? "正在编辑想法。请先保存或取消修改，再执行其他数据操作。"
        : composerHasDraft
          ? "有尚未提交的新增草稿。请先保存或清空，再执行其他数据操作。"
          : null,
    );
    this.#shell.setMutationControlsDisabled(hasDraft || this.#runtime === null);
    this.#shell.elements.composerInput.disabled = editing;
    this.#shell.elements.composerClearButton.disabled = editing;
    this.#shell.elements.composerSaveButton.disabled = editing;
    this.#shell.setHistoryCollapseDraftLocked(hasDraft);
  }

  #renderThoughts(): void {
    const query = this.#searchQuery();
    const sorted = [...this.#payload.thoughts].sort(compareByLastModified);
    const matching = query.length === 0
      ? sorted
      : sorted.filter((thought) =>
        thought.versions.some((version) => matchesQuery(version.content, query))
      );
    const draftPresent = this.#hasDraft();
    const views: ThoughtCardView[] = matching.map((thought) => {
      const latest = latestVersion(thought);
      const oldHistoryMatches = query.length === 0
        ? 0
        : thought.versions.slice(0, -1).filter((version) =>
          matchesQuery(version.content, query)
        ).length;
      const editing = this.#editing?.thoughtId === thought.id;
      return {
        id: thought.id,
        content: latest.content,
        modifiedAt: latest.createdAt,
        historyMatchCount: oldHistoryMatches,
        highlightQuery: query,
        editing,
        editDraft: editing ? this.#editing?.draft : undefined,
        editError: editing ? this.#editing?.error : null,
        historyOpen: this.#selectedHistoryId === thought.id,
        mutationsDisabled: draftPresent || this.#runtime === null,
      };
    });
    this.#shell.renderThoughts(
      views,
      this.#payload.thoughts.length === 0
        ? "还没有想法。先记录第一条吧。"
        : "没有找到匹配的想法。",
    );
    this.#shell.setSearchStatus(
      query.length === 0
        ? null
        : `找到 ${views.length} 条匹配的想法。`,
    );
    this.#renderDraftState();
  }

  #renderHistory(): void {
    const thought = this.#selectedHistoryId
      ? this.#findThought(this.#selectedHistoryId)
      : null;
    if (!thought) {
      this.#selectedHistoryId = null;
      this.#shell.setHistoryOpen(false);
      this.#shell.renderHistory(null);
      return;
    }
    const collapsed = new Set(thought.collapsedVersionIds);
    const query = this.#searchQuery();
    const history: ThoughtHistoryView = {
      thoughtId: thought.id,
      versions: thought.versions.map((version) => {
        const forcedExpanded =
          query.length > 0 && matchesQuery(version.content, query);
        return {
          id: version.id,
          content: version.content,
          createdAt: version.createdAt,
          collapsed: collapsed.has(version.id) && !forcedExpanded,
          collapseLockedMessage: forcedExpanded
            ? "搜索命中的版本会保持展开；清除搜索后可以折叠。"
            : undefined,
          highlightQuery: query,
        };
      }),
    };
    this.#shell.setHistoryOpen(true);
    this.#shell.renderHistory(history);
    this.#shell.setHistoryCollapseDraftLocked(this.#hasDraft());
  }

  #updateRenderedMutationButtons(): void {
    const disabled = this.#hasDraft() || this.#runtime === null;
    const buttons = this.#shell.elements.thoughtList.querySelectorAll<HTMLButtonElement>(
      'button[data-action="delete-thought"], button[data-action="edit-thought"]',
    );
    for (const button of buttons) button.disabled = disabled;
  }

  #retainVisibleHistorySelection(): void {
    if (!this.#selectedHistoryId) return;
    const thought = this.#findThought(this.#selectedHistoryId);
    const query = this.#searchQuery();
    if (
      !thought
      || (
        query.length > 0
        && !thought.versions.some((version) => matchesQuery(version.content, query))
      )
    ) {
      this.#selectedHistoryId = null;
    }
  }

  #reconcileLiveState(): void {
    if (this.#editing && !this.#findThought(this.#editing.thoughtId)) {
      this.#editing = null;
    }
    if (this.#selectedHistoryId && !this.#findThought(this.#selectedHistoryId)) {
      this.#selectedHistoryId = null;
    }
    this.#retainVisibleHistorySelection();
  }

  #showDraftGateMessage(): void {
    this.#shell.showMessage(
      "请先保存、清空或取消当前草稿，再执行这项操作。",
      "normal",
    );
  }

  #focusEditor(thoughtId: string): void {
    this.#pageWindow.queueMicrotask(() => {
      this.#shell.elements.thoughtList
        .querySelector<HTMLTextAreaElement>(
          `textarea[data-role="edit-input"][data-thought-id="${thoughtId}"]`,
        )
        ?.focus();
    });
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
    return this.#payload.thoughts.find((thought) => thought.id === thoughtId) ?? null;
  }

  #searchQuery(): string {
    return this.#shell.elements.searchInput.value.trim();
  }

  #hasDraft(): boolean {
    return this.#editing !== null
      || this.#shell.elements.composerInput.value.length > 0;
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

function normalizeDraft(value: string): string | null {
  try {
    return normalizeFragmentThoughtContent(value);
  } catch {
    return null;
  }
}

function latestVersion(thought: FragmentThought): FragmentThoughtVersion {
  const version = thought.versions.at(-1);
  if (!version) throw new Error("A Fragment Thought has no versions.");
  return version;
}

function compareByLastModified(
  left: FragmentThought,
  right: FragmentThought,
): number {
  const timeDifference =
    Date.parse(latestVersion(right).createdAt)
    - Date.parse(latestVersion(left).createdAt);
  return timeDifference !== 0 ? timeDifference : left.id.localeCompare(right.id);
}

function matchesQuery(content: string, query: string): boolean {
  return query.length === 0
    || content.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

function contentKey(payload: FragmentThoughtsPayload): string {
  return fragmentThoughtsDefinition.contentKey(payload);
}
