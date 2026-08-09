import {
  AddOne,
  Down,
  Right,
} from "@icon-park/svg";
import {
  ModuleSyncUi,
  type ModuleRuntime,
  type ModuleRuntimeHooks,
  type ModuleRuntimeSnapshot,
  type ModuleSyncAction,
  type ProjectionReason,
  type SettleReason,
} from "../../shared";
import {
  compareTodoInstances,
  applyTodosEvent,
  createTodoTask,
  createTodosEvent,
  deleteTaskAndReconnect,
  findTask,
  generateMissingPeriodicInstances,
  isTaskComplete,
  nextTodoBoundary,
  reorderDependencyGroup,
  taskProgress,
  toggleTodoLeaf,
  todoStatus,
  validateTodosPayload,
  type TodoInstance,
  type TodoRecurrenceRule,
  type TodoStatus,
  type TodoTask,
  type TodosEvent,
  type TodosPayload,
} from "../domain";
import { TodoConfirmDialog } from "../ui/confirmDialog";
import { TodoEditorDialog } from "../ui/editorDialog";
import { GraphPanController } from "../ui/graphPanController";
import { createTodoIcon } from "../ui/icons";
import { TodoInstanceEditor } from "../ui/instanceEditor";
import { PointerReorder } from "../ui/pointerReorder";
import { TodoRecurrenceEditor } from "../ui/recurrenceEditor";
import { TaskGraphView } from "../ui/taskGraphView";
import { TaskStructureEditor } from "../ui/taskStructureEditor";
import {
  textButton,
  TodosShell,
} from "../ui/shell";
import {
  executeTodoPersistedCommand,
  executeTodoSave,
  planTodoCommandState,
  planTodoRetryState,
  type TodoRuntimeCommand,
} from "./persistedCommands";

type TodosRuntime = ModuleRuntime<TodosPayload, TodosEvent>;
type TodoCommitRenderer = "all" | ((payload: TodosPayload) => void);

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

const STATUS_LABELS: Record<TodoStatus, string> = {
  overdue: "已截止",
  reminded: "已提醒",
  pending: "未提醒",
  completed: "已完成",
};

interface TodoGraphBinding {
  readonly view: TaskGraphView;
  readonly reorderUnbinds: Map<HTMLElement, () => void>;
  readonly disposeNavigation: () => void;
}

interface TodoStructureBinding {
  readonly editor: TaskStructureEditor;
  readonly reorderUnbinds: Map<HTMLElement, () => void>;
  reorder: (draggedGroupId: string, beforeGroupId: string | null) => void;
}

export class TodosController {
  readonly hooks: ModuleRuntimeHooks<TodosPayload, TodosEvent>;
  readonly #shell: TodosShell;
  readonly #syncUi: ModuleSyncUi;
  readonly #window: Window;
  readonly #pointerReorder: PointerReorder;
  readonly #graphPan: GraphPanController;
  readonly #confirmDialog: TodoConfirmDialog;
  readonly #removeListeners: Array<() => void> = [];
  readonly #instanceGraphs = new Map<string, TodoGraphBinding>();
  readonly #ruleGraphs = new Map<string, TodoGraphBinding>();
  #runtime: TodosRuntime | null = null;
  #payload: TodosPayload = { instances: [], rules: [] };
  #snapshot = EMPTY_SNAPSHOT;
  #localSaveFailed = false;
  #activeDialog: TodoEditorDialog | null = null;
  #activeDraft: TodoInstanceEditor | TodoRecurrenceEditor | null = null;
  #activeStructure: TodoStructureBinding | null = null;
  readonly #graphScrollLeft = new Map<string, number>();
  readonly #ruleGraphScrollLeft = new Map<string, number>();
  readonly #collapsedRuleIds = new Set<string>();
  #boundaryTimer: number | null = null;
  #disposed = false;

  constructor(appRoot: HTMLElement) {
    const pageWindow = appRoot.ownerDocument.defaultView;
    if (!pageWindow) throw new Error("Todos window is unavailable.");
    this.#window = pageWindow;
    this.#shell = new TodosShell(appRoot);
    this.#pointerReorder = new PointerReorder({ root: this.#shell.elements.root });
    this.#graphPan = new GraphPanController({ root: this.#shell.elements.root });
    this.#confirmDialog = new TodoConfirmDialog(
      this.#shell.document,
      this.#shell.elements.root,
    );
    this.#syncUi = new ModuleSyncUi({
      mount: this.#shell.elements.syncMount,
      guardAction: (action) => this.#guardSync(action),
    });
    this.hooks = {
      settle: (reason) => this.#settle(reason),
      project: (payload, reason) => this.#project(payload, reason),
      onSnapshotChange: (snapshot) => this.#onSnapshotChange(snapshot),
    };
    this.#bindUi();
    this.#renderAll();
  }

  attachRuntime(runtime: TodosRuntime, payload: TodosPayload): void {
    this.#runtime = runtime;
    this.#payload = payload;
    this.#snapshot = runtime.getSnapshot();
    this.#syncUi.attachRuntime(runtime);
    this.#renderAll();
    void this.#runPeriodicGeneration();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#confirmDialog.dispose();
    this.#closeDialogWithoutSave(false);
    this.#graphPan.dispose();
    this.#pointerReorder.dispose();
    this.#disposeStructureEditor();
    this.#disposeGraphBindings(this.#instanceGraphs, this.#graphScrollLeft);
    this.#disposeGraphBindings(this.#ruleGraphs, this.#ruleGraphScrollLeft);
    if (this.#boundaryTimer !== null) this.#window.clearTimeout(this.#boundaryTimer);
    for (const remove of this.#removeListeners.splice(0)) remove();
    this.#syncUi.dispose();
    this.#shell.dispose();
    const runtime = this.#runtime;
    this.#runtime = null;
    await runtime?.dispose();
  }

  #bindUi(): void {
    const elements = this.#shell.elements;
    this.#listen(elements.addTodoButton, "click", () => this.#openNewTodo());
    this.#listen(elements.openRulesButton, "click", () => this.#openRulesManager());
    this.#listen(elements.retrySaveButton, "click", () => void this.#retrySave());
    this.#listen(this.#window, "keydown", (event) => this.#onKeyDown(event as KeyboardEvent));
    this.#listen(this.#window, "focus", () => void this.#runPeriodicGeneration());
    this.#listen(this.#window.document, "visibilitychange", () => {
      if (this.#window.document.visibilityState === "visible") void this.#runPeriodicGeneration();
    });
    this.#listen(this.#window, "beforeunload", (event) => this.#onBeforeUnload(event as BeforeUnloadEvent));
  }

  #settle(reason: SettleReason): TodosEvent | null {
    const draft = this.#activeDraft;
    if (!draft) return null;
    try {
      const event = draft.settle(this.#payload);
      if (event) this.#payload = applyTodosEvent(this.#payload, event);
      this.#closeDialogWithoutSave();
      this.#renderAll();
      if (reason === "remote-change") {
        this.#shell.showMessage("检测到云端变化，当前有效编辑已先结算。", "normal");
      }
      return event;
    } catch {
      this.#closeDialogWithoutSave();
      this.#shell.showMessage("当前无效编辑已恢复为保存前内容。", "error");
      return null;
    }
  }

  #project(payload: TodosPayload, _reason: ProjectionReason): void {
    this.#payload = payload;
    this.#closeDialogWithoutSave();
    this.#renderAll();
  }

  #onSnapshotChange(snapshot: ModuleRuntimeSnapshot): void {
    this.#snapshot = snapshot;
    this.#syncUi.renderSnapshot(snapshot);
    this.#renderCommandState();
  }

  #guardSync(_action: ModuleSyncAction): { status: "ready" } | { status: "blocked"; message: string } {
    if (this.#activeDialog || this.#pointerReorder.dragging || this.#pointerReorder.pending) {
      return { status: "blocked", message: "请先完成当前编辑或拖动，再执行同步操作。" };
    }
    if (this.#snapshot.sessionDirty || this.#localSaveFailed) {
      return { status: "blocked", message: "请先等待本机保存成功或重试保存，再执行同步操作。" };
    }
    return { status: "ready" };
  }

  #renderAll(): void {
    this.#renderSnapshot();
    this.#renderInstances();
    this.#renderRules();
    this.#renderCommandState();
  }

  #renderSnapshot(): void {
    this.#syncUi.renderSnapshot(this.#snapshot);
    this.#syncUi.setLocalSaveFailed(this.#localSaveFailed);
    this.#shell.setSaveFailure(this.#localSaveFailed);
  }

  #renderCommandState(): void {
    const blocked = this.#activeDialog !== null || this.#runtime === null;
    this.#shell.elements.addTodoButton.disabled = blocked;
    this.#shell.elements.openRulesButton.disabled = this.#runtime === null;
  }

  #renderInstances(): void {
    const list = this.#shell.elements.todoList;
    this.#disposeGraphBindings(this.#instanceGraphs, this.#graphScrollLeft);
    list.replaceChildren();
    const now = new Date();
    const instances = [...this.#payload.instances].sort((left, right) =>
      compareTodoInstances(left, right, now));
    const instanceIds = new Set(instances.map((instance) => instance.id));
    for (const instanceId of this.#graphScrollLeft.keys()) {
      if (!instanceIds.has(instanceId)) this.#graphScrollLeft.delete(instanceId);
    }
    if (instances.length === 0) {
      list.append(this.#empty("还没有待办。先创建第一项吧。"));
      return;
    }
    for (const instance of instances) list.append(this.#renderInstance(instance, now));
  }

  #renderInstance(instance: TodoInstance, now: Date): HTMLElement {
    const status = todoStatus(instance, now);
    const article = this.#shell.document.createElement("article");
    article.className = "todo-card";
    article.dataset.status = status;
    article.dataset.instanceId = instance.id;

    const header = this.#shell.document.createElement("div");
    header.className = "todo-card-header";
    const summary = this.#shell.document.createElement("div");
    summary.className = "todo-card-summary";
    const expand = this.#shell.document.createElement("button");
    expand.type = "button";
    expand.className = "todo-expand";
    expand.append(createTodoIcon(this.#shell.document, instance.expanded ? Down : Right, 18));
    expand.title = instance.expanded ? "收起子任务" : "展开子任务";
    expand.setAttribute("aria-label", expand.title);
    expand.setAttribute("aria-expanded", String(instance.expanded));
    expand.disabled = instance.root.children.length === 0;
    expand.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.#toggleExpanded(instance.id);
    });
    const checkbox = this.#taskCheckbox(instance, instance.root);
    const open = this.#shell.document.createElement("button");
    open.type = "button";
    open.className = "todo-title-button";
    open.addEventListener("click", () => this.#openInstanceEditor(instance.id, instance.root.id));
    const name = this.#shell.document.createElement("strong");
    name.textContent = instance.root.name;
    open.append(name);
    open.setAttribute("aria-label", `${instance.root.name}，${STATUS_LABELS[status]}`);
    const date = this.#shell.document.createElement("time");
    date.className = "todo-date";
    date.textContent = instance.deadlineAt === null
      ? "无截止日期"
      : formatDisplayDate(instance.deadlineAt);
    if (instance.deadlineAt) date.dateTime = instance.deadlineAt;
    header.append(expand, checkbox, open, date);
    summary.append(header, this.#progressBar(taskProgress(instance.root), instance.root.id));
    article.append(summary);

    if (instance.root.children.length > 0) {
      article.append(this.#graphReveal(
        this.#createTaskGraph("instance", instance.id, instance.root, instance.expanded),
        instance.expanded,
      ));
    }
    return article;
  }

  #graphReveal(graph: HTMLElement, expanded = true): HTMLElement {
    const reveal = this.#shell.document.createElement("div");
    reveal.className = "todo-graph-reveal";
    reveal.dataset.expanded = String(expanded);
    const inner = this.#shell.document.createElement("div");
    inner.className = "todo-graph-reveal-inner";
    inner.append(graph);
    reveal.append(inner);
    return reveal;
  }

  #createTaskGraph(
    kind: "instance" | "template",
    ownerId: string,
    root: TodoTask,
    expanded: boolean,
  ): HTMLElement {
    const scrollPositions = kind === "instance"
      ? this.#graphScrollLeft
      : this.#ruleGraphScrollLeft;
    const view = new TaskGraphView(this.#shell.document, {
      kind,
      ownerId,
      initialScrollLeft: scrollPositions.get(ownerId) ?? 0,
      callbacks: kind === "instance"
        ? {
          onOpenTask: (taskId) => this.#openInstanceEditor(ownerId, taskId),
          onToggleTask: (taskId) => void this.#toggleTask(ownerId, taskId),
          onContextTask: (taskId) => {
            if (!this.#activeDialog) void this.#deleteGraphTask(ownerId, taskId);
          },
          onReorderGroup: ({ draggedGroupId, beforeGroupId }) => {
            void this.#reorderGraphTask(ownerId, draggedGroupId, beforeGroupId);
          },
          onScrollLeftChange: (scrollLeft) => this.#graphScrollLeft.set(ownerId, scrollLeft),
        }
        : {
          onOpenTask: (taskId) => {
            const trigger = this.#activeDialog?.trigger;
            this.#closeDialogWithoutSave(false);
            this.#openRuleEditor(ownerId, taskId, trigger);
          },
          onContextTask: (taskId) => void this.#deleteRuleGraphTask(ownerId, taskId),
          onReorderGroup: ({ draggedGroupId, beforeGroupId }) => {
            void this.#reorderRuleGraphTask(ownerId, draggedGroupId, beforeGroupId);
          },
          onScrollLeftChange: (scrollLeft) => this.#ruleGraphScrollLeft.set(ownerId, scrollLeft),
        },
    });
    view.render({ root, expanded, disabled: this.#runtime === null });
    const binding: TodoGraphBinding = {
      view,
      reorderUnbinds: new Map(),
      disposeNavigation: this.#graphPan.bind(view.element, {
        isInteractionBlocked: () => this.#pointerReorder.dragging,
        cancelPendingInteraction: () => this.#pointerReorder.cancel(),
      }),
    };
    const graphMap = kind === "instance" ? this.#instanceGraphs : this.#ruleGraphs;
    graphMap.set(ownerId, binding);
    this.#syncGraphReorderBindings(binding);
    return view.element;
  }

  #syncGraphReorderBindings(binding: TodoGraphBinding): void {
    const sources = new Set(
      binding.view.element.querySelectorAll<HTMLElement>(".todo-task-node[data-drag-group-id]"),
    );
    for (const [source, unbind] of binding.reorderUnbinds) {
      if (sources.has(source)) continue;
      unbind();
      binding.reorderUnbinds.delete(source);
    }
    for (const source of sources) {
      if (binding.reorderUnbinds.has(source)) continue;
      const unbind = this.#pointerReorder.bind(source, () => {
        if (source.dataset.draggable !== "true") return null;
        const groupId = source.dataset.dragGroupId;
        if (!groupId) return null;
        const groups = binding.view.getReorderGroups();
        const dragged = groups.find((group) => group.groupId === groupId);
        const container = dragged?.element.parentElement;
        if (!dragged || !container) return null;
        const siblings = groups.filter((group) =>
          group.parentTaskId === dragged.parentTaskId
          && group.element.parentElement === container);
        return {
          axis: "horizontal",
          groupId,
          container,
          blocks: siblings.map((group) => ({
            groupId: group.groupId,
            elements: [group.element],
          })),
          captureTarget: binding.view.element,
          scrollHost: binding.view.element,
          stateHost: binding.view.element,
          touchActivation: "long-press",
          onLayoutChange: () => binding.view.redrawConnections(),
          onCommit: (beforeGroupId) => binding.view.requestReorder(groupId, beforeGroupId),
        };
      });
      binding.reorderUnbinds.set(source, unbind);
    }
  }

  #disposeGraphBindings(
    bindings: Map<string, TodoGraphBinding>,
    scrollPositions: Map<string, number>,
  ): void {
    for (const [ownerId, binding] of bindings) {
      scrollPositions.set(ownerId, binding.view.savedScrollLeft);
      for (const unbind of binding.reorderUnbinds.values()) unbind();
      binding.reorderUnbinds.clear();
      binding.disposeNavigation();
      binding.view.dispose();
    }
    bindings.clear();
  }

  #activateStructureEditor(editor: TaskStructureEditor): TodoStructureBinding {
    this.#disposeStructureEditor();
    const binding: TodoStructureBinding = {
      editor,
      reorderUnbinds: new Map(),
      reorder: () => undefined,
    };
    this.#activeStructure = binding;
    return binding;
  }

  #syncStructureReorderBindings(
    binding: TodoStructureBinding,
    reorder: (draggedGroupId: string, beforeGroupId: string | null) => void,
  ): void {
    binding.reorder = reorder;
    const rows = binding.editor.getTaskRows();
    const sources = new Set(rows.map((row) => row.dragSource));
    for (const [source, unbind] of binding.reorderUnbinds) {
      if (sources.has(source)) continue;
      unbind();
      binding.reorderUnbinds.delete(source);
    }
    for (const row of rows) {
      if (binding.reorderUnbinds.has(row.dragSource)) continue;
      const unbind = this.#pointerReorder.bind(row.dragSource, () => {
        if (binding.editor.disabled) return null;
        const current = binding.editor.getTaskRow(row.taskId);
        if (!current) return null;
        const groups = binding.editor.getReorderGroups();
        if (!groups.some((group) => group.groupId === current.groupId)) return null;
        return {
          axis: "vertical",
          groupId: current.groupId,
          container: binding.editor.reorderContainer,
          blocks: groups.map((group) => ({
            groupId: group.groupId,
            elements: group.elements,
          })),
          captureTarget: binding.editor.reorderContainer,
          scrollHost: binding.editor.scrollElement,
          stateHost: binding.editor.element,
          touchActivation: "long-press",
          onLayoutChange: () => binding.editor.redrawConnections(),
          onCommit: (beforeGroupId) => binding.reorder(current.groupId, beforeGroupId),
        };
      });
      binding.reorderUnbinds.set(row.dragSource, unbind);
    }
  }

  #disposeStructureEditor(): void {
    const binding = this.#activeStructure;
    if (!binding) return;
    this.#activeStructure = null;
    for (const unbind of binding.reorderUnbinds.values()) unbind();
    binding.reorderUnbinds.clear();
    binding.editor.dispose();
  }

  #taskCheckbox(instance: TodoInstance, task: TodoTask): HTMLInputElement {
    const checkbox = this.#shell.document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo-checkbox";
    checkbox.dataset.taskId = task.id;
    this.#syncTaskCheckbox(checkbox, instance, task);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => void this.#toggleTask(instance.id, task.id));
    return checkbox;
  }

  #progressBar(progress: number, taskId: string): HTMLProgressElement {
    const bar = this.#shell.document.createElement("progress");
    bar.className = "todo-progress";
    bar.dataset.taskId = taskId;
    bar.max = 1;
    bar.value = Math.max(0, Math.min(1, progress));
    bar.setAttribute("aria-label", "任务进度");
    return bar;
  }

  #renderRules(): void {
    const list = this.#shell.elements.ruleList;
    this.#disposeGraphBindings(this.#ruleGraphs, this.#ruleGraphScrollLeft);
    list.replaceChildren();
    const ruleIds = new Set(this.#payload.rules.map((rule) => rule.id));
    for (const ruleId of this.#collapsedRuleIds) {
      if (!ruleIds.has(ruleId)) this.#collapsedRuleIds.delete(ruleId);
    }
    for (const ruleId of this.#ruleGraphScrollLeft.keys()) {
      if (!ruleIds.has(ruleId)) this.#ruleGraphScrollLeft.delete(ruleId);
    }
    if (this.#payload.rules.length === 0) {
      list.append(this.#empty("还没有周期待办模板。"));
      return;
    }
    for (const rule of this.#payload.rules) {
      list.append(this.#renderRulePreview(rule));
    }
  }

  #renderRulePreview(rule: TodoRecurrenceRule): HTMLElement {
    const article = this.#shell.document.createElement("article");
    article.className = "todo-rule-preview";
    article.dataset.ruleId = rule.id;
    const summary = this.#shell.document.createElement("div");
    summary.className = "todo-card-summary";
    const header = this.#shell.document.createElement("div");
    header.className = "todo-card-header";
    const collapsed = this.#collapsedRuleIds.has(rule.id);
    const expand = this.#shell.document.createElement("button");
    expand.type = "button";
    expand.className = "todo-expand";
    expand.append(createTodoIcon(this.#shell.document, collapsed ? Right : Down, 18));
    expand.title = collapsed ? "展开模板子任务" : "收起模板子任务";
    expand.setAttribute("aria-label", expand.title);
    expand.setAttribute("aria-expanded", String(!collapsed));
    expand.disabled = rule.template.children.length === 0;
    expand.addEventListener("click", () => this.#toggleRuleExpanded(rule.id));
    const open = this.#shell.document.createElement("button");
    open.type = "button";
    open.className = "todo-title-button";
    open.setAttribute("aria-label", `编辑周期待办模板：${rule.template.name}`);
    open.addEventListener("click", () => {
      const trigger = this.#activeDialog?.trigger;
      this.#closeDialogWithoutSave(false);
      this.#openRuleEditor(rule.id, rule.template.id, trigger);
    });
      const name = this.#shell.document.createElement("strong");
      name.textContent = rule.template.name;
    open.append(name);
    const cadence = this.#shell.document.createElement("span");
    cadence.className = "todo-date";
    cadence.textContent = rule.cadence === "weekly" ? "每周一生成" : "每月一日生成";
    header.append(expand, open, cadence);
    summary.append(header);
    article.append(summary);
    if (rule.template.children.length > 0) {
      article.append(this.#graphReveal(
        this.#createTaskGraph("template", rule.id, rule.template, !collapsed),
        !collapsed,
      ));
    }
    return article;
  }

  #openRulesManager(): void {
    if (this.#activeDialog) return;
    let dialog!: TodoEditorDialog;
    dialog = new TodoEditorDialog(this.#shell.document, {
      mount: this.#shell.elements.root,
      title: "周期待办",
      classNames: "todo-rules-dialog",
      onCancel: () => {
        if (this.#activeDialog === dialog) this.#closeDialogWithoutSave();
      },
    });
    const heading = this.#shell.document.createElement("div");
    heading.className = "todo-rules-heading";
    const title = this.#shell.document.createElement("h3");
    title.textContent = "周期待办模板";
    const add = textButton(
      this.#shell.document,
      "添加模板",
      "todos-button primary compact",
      AddOne,
    );
    add.addEventListener("click", () => {
      const trigger = dialog.trigger;
      this.#closeDialogWithoutSave(false);
      this.#openNewRule(trigger);
    });
    heading.append(title, add);
    dialog.body.append(heading, this.#shell.elements.ruleList);
    this.#renderRules();
    this.#activateDialog(dialog);
    dialog.open(add);
  }

  #openNewTodo(): void {
    const now = new Date();
    const root = createTodoTask(this.#createId(), "新待办");
    const instance: TodoInstance = {
      id: this.#createId(),
      createdAt: now.toISOString(),
      reminderAt: now.toISOString(),
      deadlineAt: null,
      completedAt: null,
      expanded: false,
      sourceRuleId: null,
      sourcePeriodKey: null,
      root,
    };
    this.#openInstanceDraft(instance, true, root.id);
  }

  #openInstanceEditor(instanceId: string, taskId: string): void {
    const instance = this.#payload.instances.find((candidate) => candidate.id === instanceId);
    if (instance) this.#openInstanceDraft(instance, false, taskId);
  }

  #openInstanceDraft(
    baseline: TodoInstance,
    isNew: boolean,
    taskId: string,
    draft: TodoInstance = baseline,
    trigger?: HTMLElement | null,
  ): void {
    if (this.#activeDialog) return;
    let structureBinding: TodoStructureBinding | null = null;
    let editor!: TodoInstanceEditor;
    editor = new TodoInstanceEditor(this.#shell.document, {
      mount: this.#shell.elements.root,
      baseline,
      draft,
      taskId,
      isNew,
      trigger,
      createId: () => this.#createId(),
      getPayload: () => this.#payload,
      commit: (next) => this.#commit(next),
      confirm: (options) => this.#confirmDialog.confirm(options),
      requestClose: () => {
        if (this.#activeDraft === editor) this.#closeDialogWithoutSave();
      },
      openTask: (nextDraft, nextTaskId) => {
        if (this.#activeDraft !== editor) return;
        const restoreTrigger = editor.trigger;
        this.#closeDialogWithoutSave(false);
        this.#openInstanceDraft(
          baseline,
          isNew,
          nextTaskId,
          nextDraft,
          restoreTrigger,
        );
      },
      bindStructure: (structure, reorder) => {
        structureBinding ??= this.#activateStructureEditor(structure);
        this.#syncStructureReorderBindings(structureBinding, reorder);
      },
      showMessage: (message, tone) => this.#shell.showMessage(message, tone),
    });
    this.#activateDraft(editor);
    editor.open();
  }

  #openNewRule(trigger?: HTMLElement | null): void {
    const now = new Date();
    const rule: TodoRecurrenceRule = {
      id: this.#createId(),
      createdAt: now.toISOString(),
      cadence: "weekly",
      template: createTodoTask(this.#createId(), "新周期模板"),
      generatedThrough: { weekly: null, monthly: null },
    };
    this.#openRuleDraft(rule, true, rule.template.id, rule, trigger);
  }

  #openRuleEditor(
    ruleId: string,
    taskId?: string,
    trigger?: HTMLElement | null,
  ): void {
    const rule = this.#payload.rules.find((candidate) => candidate.id === ruleId);
    if (rule) this.#openRuleDraft(rule, false, taskId ?? rule.template.id, rule, trigger);
  }

  #openRuleDraft(
    baseline: TodoRecurrenceRule,
    isNew: boolean,
    taskId: string,
    draft: TodoRecurrenceRule = baseline,
    trigger?: HTMLElement | null,
  ): void {
    if (this.#activeDialog) return;
    let structureBinding: TodoStructureBinding | null = null;
    let editor!: TodoRecurrenceEditor;
    editor = new TodoRecurrenceEditor(this.#shell.document, {
      mount: this.#shell.elements.root,
      baseline,
      draft,
      taskId,
      isNew,
      trigger,
      createId: () => this.#createId(),
      getPayload: () => this.#payload,
      commit: (next) => this.#commit(next),
      confirm: (options) => this.#confirmDialog.confirm(options),
      requestClose: () => {
        if (this.#activeDraft === editor) this.#closeDialogWithoutSave();
      },
      openTask: (nextDraft, nextTaskId) => {
        if (this.#activeDraft !== editor) return;
        const restoreTrigger = editor.trigger;
        this.#closeDialogWithoutSave(false);
        this.#openRuleDraft(
          baseline,
          isNew,
          nextTaskId,
          nextDraft,
          restoreTrigger,
        );
      },
      bindStructure: (structure, reorder) => {
        structureBinding ??= this.#activateStructureEditor(structure);
        this.#syncStructureReorderBindings(structureBinding, reorder);
      },
      showMessage: (message, tone) => this.#shell.showMessage(message, tone),
    });
    this.#activateDraft(editor);
    editor.open();
  }

  #activateDialog(dialog: TodoEditorDialog): void {
    this.#activeDialog = dialog;
    this.#renderCommandState();
  }

  #activateDraft(draft: TodoInstanceEditor | TodoRecurrenceEditor): void {
    this.#activeDraft = draft;
    this.#activateDialog(draft.dialog);
  }

  #closeDialogWithoutSave(restoreFocus = true): void {
    const dialog = this.#activeDialog;
    const draft = this.#activeDraft;
    const containsRuleList = dialog?.dialog.contains(this.#shell.elements.ruleList) ?? false;
    this.#activeDialog = null;
    this.#activeDraft = null;
    this.#pointerReorder.cancel();
    this.#disposeStructureEditor();
    if (containsRuleList) {
      this.#disposeGraphBindings(this.#ruleGraphs, this.#ruleGraphScrollLeft);
    }
    if (draft) draft.dispose(restoreFocus);
    else dialog?.dispose(restoreFocus);
    this.#renderCommandState();
  }

  #syncTaskCheckbox(checkbox: HTMLInputElement, instance: TodoInstance, task: TodoTask): void {
    checkbox.checked = isTaskComplete(task);
    const predecessor = task.predecessorId ? findTask(instance.root, task.predecessorId) : null;
    const locked = Boolean(predecessor && !isTaskComplete(predecessor));
    checkbox.disabled = task.children.length > 0 || locked || this.#runtime === null;
    checkbox.title = task.children.length > 0
      ? "完成状态由所有子任务决定"
      : locked ? "请先完成前置任务" : "切换完成状态";
    checkbox.setAttribute("aria-label", `${task.name}：${checkbox.title}`);
  }

  async #toggleTask(instanceId: string, taskId: string): Promise<void> {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    if (!instance) return;
    try {
      const nextInstance = toggleTodoLeaf(instance, taskId, new Date());
      await this.#commit({
        ...this.#payload,
        instances: this.#payload.instances.map((item) => item.id === instance.id ? nextInstance : item),
      }, () => this.#patchInstancePresentation(instanceId));
    } catch (error) {
      this.#shell.showMessage(safeMessage(error, "完成状态未能更新。"), "error");
      this.#patchInstancePresentation(instanceId);
    }
  }

  async #reorderGraphTask(
    instanceId: string,
    draggedGroupId: string,
    beforeGroupId: string | null,
  ): Promise<void> {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    if (!instance) return;
    try {
      const root = reorderDependencyGroup(instance.root, draggedGroupId, beforeGroupId);
      await this.#commit({
        ...this.#payload,
        instances: this.#payload.instances.map((item) => item.id === instanceId ? { ...item, root } : item),
      }, () => this.#patchInstancePresentation(instanceId));
    } catch (error) {
      this.#shell.showMessage(safeMessage(error, "只能调整同一父任务下的任务组。"), "error");
      this.#restoreInstanceGraph(instanceId);
    }
  }

  async #reorderRuleGraphTask(
    ruleId: string,
    draggedGroupId: string,
    beforeGroupId: string | null,
  ): Promise<void> {
    const rule = this.#payload.rules.find((item) => item.id === ruleId);
    if (!rule) return;
    try {
      const template = reorderDependencyGroup(rule.template, draggedGroupId, beforeGroupId);
      await this.#commit({
        ...this.#payload,
        rules: this.#payload.rules.map((item) => item.id === ruleId ? { ...item, template } : item),
      }, () => this.#patchRulePresentation(ruleId));
    } catch (error) {
      this.#shell.showMessage(safeMessage(error, "只能调整同一父任务下的任务组。"), "error");
      this.#restoreRuleGraph(ruleId);
    }
  }

  async #deleteGraphTask(instanceId: string, taskId: string): Promise<void> {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    const task = instance ? findTask(instance.root, taskId) : null;
    if (!instance || !task) return;
    if (!await this.#confirmDialog.confirm({
      title: "删除子任务？",
      message: `“${task.name}”及其全部子任务都会被删除。`,
      confirmLabel: "删除子任务",
    })) return;
    const root = deleteTaskAndReconnect(instance.root, taskId);
    await this.#commit({
      ...this.#payload,
      instances: this.#payload.instances.map((item) => item.id === instanceId
        ? { ...item, root, completedAt: isTaskComplete(root) ? new Date().toISOString() : null }
        : item),
    });
  }

  async #toggleExpanded(instanceId: string): Promise<void> {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    if (!instance) return;
    await this.#setExpanded(instanceId, !instance.expanded);
  }

  async #setExpanded(instanceId: string, expanded: boolean): Promise<void> {
    await this.#commit({
      ...this.#payload,
      instances: this.#payload.instances.map((item) => item.id === instanceId
        ? { ...item, expanded }
        : item),
    }, () => this.#patchInstanceExpanded(instanceId));
  }

  #patchInstancePresentation(instanceId: string): void {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    const article = [...this.#shell.elements.todoList.querySelectorAll<HTMLElement>(".todo-card")]
      .find((candidate) => candidate.dataset.instanceId === instanceId);
    if (!instance || !article) return;
    const status = todoStatus(instance, new Date());
    article.dataset.status = status;
    const title = article.querySelector<HTMLElement>(".todo-title-button");
    title?.setAttribute("aria-label", `${instance.root.name}，${STATUS_LABELS[status]}`);
    const checkbox = article.querySelector<HTMLInputElement>(
      ":scope > .todo-card-summary .todo-checkbox[data-task-id]",
    );
    if (checkbox) this.#syncTaskCheckbox(checkbox, instance, instance.root);
    const bar = article.querySelector<HTMLProgressElement>(
      ":scope > .todo-card-summary > .todo-progress[data-task-id]",
    );
    if (bar) bar.value = Math.max(0, Math.min(1, taskProgress(instance.root)));
    const binding = this.#instanceGraphs.get(instanceId);
    if (binding) {
      binding.view.render({
        root: instance.root,
        expanded: instance.expanded,
        disabled: this.#runtime === null,
      });
      this.#syncGraphReorderBindings(binding);
    }
    this.#sortInstanceCards();
  }

  #patchRulePresentation(ruleId: string): void {
    const rule = this.#payload.rules.find((item) => item.id === ruleId);
    const binding = this.#ruleGraphs.get(ruleId);
    if (!rule || !binding) return;
    binding.view.render({
      root: rule.template,
      expanded: !this.#collapsedRuleIds.has(ruleId),
      disabled: this.#runtime === null,
    });
    this.#syncGraphReorderBindings(binding);
  }

  #sortInstanceCards(): void {
    const list = this.#shell.elements.todoList;
    const articles = [...list.querySelectorAll<HTMLElement>(":scope > .todo-card")];
    if (articles.length < 2) return;
    const byId = new Map(articles.map((article) => [article.dataset.instanceId!, article]));
    const ordered = [...this.#payload.instances]
      .sort((left, right) => compareTodoInstances(left, right, new Date()))
      .map((instance) => byId.get(instance.id))
      .filter((article): article is HTMLElement => article !== undefined);
    if (ordered.every((article, index) => article === articles[index])) return;
    const before = new Map(articles.map((article) => [article, article.getBoundingClientRect()]));
    for (const article of ordered) list.append(article);
    this.#animateFromRects(articles, before);
  }

  #animateFromRects(
    elements: readonly HTMLElement[],
    before: ReadonlyMap<HTMLElement, DOMRect>,
  ): void {
    for (const element of elements) {
      const previous = before.get(element);
      if (!previous || typeof element.animate !== "function") continue;
      const current = element.getBoundingClientRect();
      const deltaX = previous.left - current.left;
      const deltaY = previous.top - current.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      const animation = element.animate([
        { transform: `translate(${deltaX}px, ${deltaY}px)` },
        { transform: "translate(0, 0)" },
      ], { duration: 180, easing: "cubic-bezier(.22, 1, .36, 1)" });
      void animation.finished.catch(() => undefined);
    }
  }

  #toggleRuleExpanded(ruleId: string): void {
    this.#setRuleExpanded(ruleId, this.#collapsedRuleIds.has(ruleId));
  }

  #setRuleExpanded(ruleId: string, expanded: boolean): void {
    if (expanded) this.#collapsedRuleIds.delete(ruleId);
    else this.#collapsedRuleIds.add(ruleId);
    this.#patchRuleExpanded(ruleId);
  }

  #patchInstanceExpanded(instanceId: string): void {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    const article = [...this.#shell.elements.todoList.querySelectorAll<HTMLElement>(".todo-card")]
      .find((candidate) => candidate.dataset.instanceId === instanceId);
    if (!instance || !article) return;
    const button = article.querySelector<HTMLButtonElement>(":scope > .todo-card-summary .todo-expand");
    if (button) this.#syncExpandButton(button, instance.expanded, false);
    const binding = this.#instanceGraphs.get(instanceId);
    const reveal = article.querySelector<HTMLElement>(":scope > .todo-graph-reveal");
    if (binding) {
      binding.view.render({
        root: instance.root,
        expanded: instance.expanded,
        disabled: this.#runtime === null,
      });
      this.#syncGraphReorderBindings(binding);
    }
    if (reveal) this.#setGraphRevealExpanded(reveal, instance.expanded);
  }

  #patchRuleExpanded(ruleId: string): void {
    const rule = this.#payload.rules.find((item) => item.id === ruleId);
    const article = [...this.#shell.elements.ruleList.querySelectorAll<HTMLElement>(".todo-rule-preview")]
      .find((candidate) => candidate.dataset.ruleId === ruleId);
    if (!rule || !article) return;
    const expanded = !this.#collapsedRuleIds.has(ruleId);
    const button = article.querySelector<HTMLButtonElement>(":scope > .todo-card-summary .todo-expand");
    if (button) this.#syncExpandButton(button, expanded, true);
    const binding = this.#ruleGraphs.get(ruleId);
    const reveal = article.querySelector<HTMLElement>(":scope > .todo-graph-reveal");
    if (binding) {
      binding.view.render({
        root: rule.template,
        expanded,
        disabled: this.#runtime === null,
      });
      this.#syncGraphReorderBindings(binding);
    }
    if (reveal) this.#setGraphRevealExpanded(reveal, expanded);
  }

  #syncExpandButton(button: HTMLButtonElement, expanded: boolean, template: boolean): void {
    const restoreFocus = this.#shell.document.activeElement === button;
    button.replaceChildren(createTodoIcon(this.#shell.document, expanded ? Down : Right, 18));
    button.title = template
      ? expanded ? "收起模板子任务" : "展开模板子任务"
      : expanded ? "收起子任务" : "展开子任务";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(expanded));
    if (restoreFocus) button.focus({ preventScroll: true });
  }

  #setGraphRevealExpanded(reveal: HTMLElement, expanded: boolean): void {
    const graph = reveal.querySelector<HTMLElement>(".todo-graph");
    reveal.dataset.transitionTarget = String(expanded);
    if (!expanded) {
      reveal.classList.remove("is-expanding", "is-expanded");
      reveal.classList.add("is-collapsing");
      reveal.dataset.expanded = "false";
      graph?.classList.remove("is-expanding");
      graph?.classList.add("is-collapsing");
      this.#window.setTimeout(() => {
        if (reveal.dataset.transitionTarget !== "false") return;
        reveal.classList.remove("is-collapsing");
        graph?.classList.remove("is-collapsing");
      }, 280);
      return;
    }
    reveal.classList.remove("is-collapsing");
    graph?.classList.remove("is-collapsing");
    graph?.classList.add("is-expanding");
    reveal.getBoundingClientRect();
    this.#window.requestAnimationFrame(() => {
      if (reveal.dataset.transitionTarget !== "true") return;
      reveal.dataset.expanded = "true";
      reveal.classList.add("is-expanding", "is-expanded");
      this.#window.setTimeout(() => {
        if (reveal.dataset.transitionTarget !== "true") return;
        reveal.classList.remove("is-expanding", "is-expanded");
        graph?.classList.remove("is-expanding");
      }, 260);
    });
  }

  #restoreInstanceGraph(instanceId: string): void {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    const binding = this.#instanceGraphs.get(instanceId);
    if (!instance || !binding) return;
    binding.view.render({
      root: instance.root,
      expanded: instance.expanded,
      disabled: this.#runtime === null,
    });
    this.#syncGraphReorderBindings(binding);
  }

  async #deleteRuleGraphTask(ruleId: string, taskId: string): Promise<void> {
    const rule = this.#payload.rules.find((item) => item.id === ruleId);
    const task = rule ? findTask(rule.template, taskId) : null;
    if (!rule || !task) return;
    if (!await this.#confirmDialog.confirm({
      title: "删除模板子任务？",
      message: `“${task.name}”及其全部子任务都会从模板中删除。`,
      confirmLabel: "删除子任务",
    })) return;
    const template = deleteTaskAndReconnect(rule.template, taskId);
    await this.#commit({
      ...this.#payload,
      rules: this.#payload.rules.map((item) => item.id === ruleId
        ? { ...item, template }
        : item),
    });
  }

  #restoreRuleGraph(ruleId: string): void {
    const rule = this.#payload.rules.find((item) => item.id === ruleId);
    const binding = this.#ruleGraphs.get(ruleId);
    if (!rule || !binding) return;
    binding.view.render({
      root: rule.template,
      expanded: !this.#collapsedRuleIds.has(ruleId),
      disabled: this.#runtime === null,
    });
    this.#syncGraphReorderBindings(binding);
  }

  async #commit(
    nextValue: TodosPayload,
    renderer: TodoCommitRenderer = "all",
    beforeRender?: () => void,
  ): Promise<boolean> {
    const next = validateTodosPayload(nextValue);
    const event = createTodosEvent(this.#payload, next);
    if (event.instances.length === 0 && event.rules.length === 0) {
      beforeRender?.();
      if (renderer === "all") this.#renderAll();
      else {
        renderer(this.#payload);
        this.#renderSnapshot();
        this.#renderCommandState();
      }
      return true;
    }
    return this.#executeCommand({ kind: "dispatch", event }, renderer, beforeRender);
  }

  async #executeCommand(
    command: TodoRuntimeCommand<TodosEvent>,
    renderer: TodoCommitRenderer = "all",
    beforeRender?: () => void,
  ): Promise<boolean> {
    const runtime = this.#runtime;
    if (!runtime) return false;
    const result = await executeTodoPersistedCommand(runtime, command, (payload) => {
      this.#payload = payload;
      beforeRender?.();
      if (renderer === "all") this.#renderAll();
      else {
        renderer(payload);
        this.#renderSnapshot();
        this.#renderCommandState();
      }
    });
    const plan = planTodoCommandState(this.#localSaveFailed, result);
    this.#localSaveFailed = plan.localSaveFailed;
    if (plan.commandFailureMessage) {
      this.#renderAll();
      this.#shell.showMessage(plan.commandFailureMessage, "error");
      return false;
    }
    this.#renderSnapshot();
    return true;
  }

  async #retrySave(): Promise<void> {
    const runtime = this.#runtime;
    if (this.#activeDialog || !runtime) return;
    const result = await executeTodoSave(runtime);
    this.#localSaveFailed = planTodoRetryState(result);
    this.#renderSnapshot();
  }

  async #undo(): Promise<void> {
    if (!this.#runtime?.canUndo || this.#activeDialog) return;
    await this.#executeCommand({ kind: "undo" });
  }

  async #redo(): Promise<void> {
    if (!this.#runtime?.canRedo || this.#activeDialog) return;
    await this.#executeCommand({ kind: "redo" });
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (isEditableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    event.preventDefault();
    if (key === "z") void this.#undo();
    else void this.#redo();
  }

  #onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!this.#activeDialog && !this.#snapshot.sessionDirty && !this.#localSaveFailed) return;
    event.preventDefault();
    event.returnValue = "";
  }

  async #runPeriodicGeneration(): Promise<void> {
    if (!this.#runtime || this.#activeDialog) {
      this.#scheduleBoundary();
      return;
    }
    const generated = generateMissingPeriodicInstances(this.#payload, new Date(), () => this.#createId());
    if (generated.instances.length > 0) {
      await this.#commit({
        instances: [...this.#payload.instances, ...generated.instances],
        rules: generated.rules,
      });
    }
    this.#scheduleBoundary();
  }

  #scheduleBoundary(): void {
    if (this.#boundaryTimer !== null) this.#window.clearTimeout(this.#boundaryTimer);
    const now = new Date();
    const boundary = nextTodoBoundary(this.#payload.rules, now);
    if (!boundary) return;
    const delay = Math.min(2_147_000_000, Math.max(1_000, boundary.getTime() - now.getTime() + 250));
    this.#boundaryTimer = this.#window.setTimeout(() => void this.#runPeriodicGeneration(), delay);
  }

  #empty(message: string): HTMLElement {
    const empty = this.#shell.document.createElement("p");
    empty.className = "todos-empty";
    empty.textContent = message;
    return empty;
  }

  #createId(): string {
    return this.#window.crypto.randomUUID().toLowerCase();
  }

  #listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener);
    this.#removeListeners.push(() => target.removeEventListener(type, listener));
  }
}

function formatDisplayDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof TypeError ? error.message : fallback;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
  );
}
