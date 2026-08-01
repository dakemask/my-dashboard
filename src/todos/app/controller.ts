import {
  AddOne,
  ArrowRight,
  Delete,
  Down,
  Drag,
  Right,
  Save,
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
  dependencyGroups,
  findTask,
  formatTodoDateInput,
  generateMissingPeriodicInstances,
  initializeRulePeriod,
  insertParallelTask,
  insertSuccessorTask,
  isTaskComplete,
  nextTodoBoundary,
  parseTodoSpecificDate,
  reconcileTodoDates,
  reminderFromDeadline,
  deadlineFromReminder,
  reorderDependencyGroup,
  replaceTask,
  resetTaskCompletion,
  setTaskWeight,
  taskProgress,
  toggleTodoLeaf,
  todoStatus,
  validateTodosPayload,
  cloneTaskWithIds,
  type TodoInstance,
  type TodoRecurrenceRule,
  type TodoStatus,
  type TodoTask,
  type TodosEvent,
  type TodosPayload,
} from "../domain";
import { createTodoIcon } from "../ui/icons";
import {
  closeButton,
  textButton,
  TodosShell,
} from "../ui/shell";

type TodosRuntime = ModuleRuntime<TodosPayload, TodosEvent>;

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

interface TodoFieldElements {
  readonly label: HTMLLabelElement;
  readonly input: HTMLInputElement;
}

export class TodosController {
  readonly hooks: ModuleRuntimeHooks<TodosPayload, TodosEvent>;
  readonly #shell: TodosShell;
  readonly #syncUi: ModuleSyncUi;
  readonly #window: Window;
  readonly #removeListeners: Array<() => void> = [];
  #runtime: TodosRuntime | null = null;
  #payload: TodosPayload = { instances: [], rules: [] };
  #snapshot = EMPTY_SNAPSHOT;
  #localSaveFailed = false;
  #activeDialog: HTMLDialogElement | null = null;
  #dialogBuildEvent: (() => TodosEvent | null) | null = null;
  #draggingTaskId: string | null = null;
  readonly #graphScrollLeft = new Map<string, number>();
  #boundaryTimer: number | null = null;
  #disposed = false;

  constructor(appRoot: HTMLElement) {
    const pageWindow = appRoot.ownerDocument.defaultView;
    if (!pageWindow) throw new Error("Todos window is unavailable.");
    this.#window = pageWindow;
    this.#shell = new TodosShell(appRoot);
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
    if (this.#boundaryTimer !== null) this.#window.clearTimeout(this.#boundaryTimer);
    this.#activeDialog?.close();
    this.#activeDialog?.remove();
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
    this.#listen(elements.addRuleButton, "click", () => this.#openNewRule());
    this.#listen(elements.openRulesButton, "click", () => this.#openRulesManager());
    this.#listen(elements.retrySaveButton, "click", () => void this.#retrySave());
    this.#listen(this.#window, "keydown", (event) => this.#onKeyDown(event as KeyboardEvent));
    this.#listen(this.#window, "focus", () => void this.#runPeriodicGeneration());
    this.#listen(this.#window.document, "visibilitychange", () => {
      if (this.#window.document.visibilityState === "visible") void this.#runPeriodicGeneration();
    });
    this.#listen(this.#window, "resize", () => this.#scheduleGraphLines());
    this.#listen(this.#window, "beforeunload", (event) => this.#onBeforeUnload(event as BeforeUnloadEvent));
  }

  #settle(reason: SettleReason): TodosEvent | null {
    if (!this.#activeDialog || !this.#dialogBuildEvent) return null;
    try {
      const event = this.#dialogBuildEvent();
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
    if (this.#activeDialog || this.#draggingTaskId) {
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
    this.#shell.elements.addRuleButton.disabled = blocked;
    this.#shell.elements.openRulesButton.disabled = this.#runtime === null;
  }

  #renderInstances(): void {
    const list = this.#shell.elements.todoList;
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
    this.#scheduleGraphLines();
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
      void this.#setExpanded(instance, !instance.expanded);
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
    summary.append(header, this.#progressBar(taskProgress(instance.root)));
    article.append(summary);

    if (instance.expanded && instance.root.children.length > 0) {
      const graph = this.#shell.document.createElement("div");
      graph.className = "todo-graph";
      graph.dataset.instanceId = instance.id;
      const canvas = this.#shell.document.createElement("div");
      canvas.className = "todo-graph-canvas";
      const svg = this.#shell.document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("todo-graph-lines");
      svg.setAttribute("aria-hidden", "true");
      const content = this.#shell.document.createElement("div");
      content.className = "todo-graph-content";
      content.append(this.#renderTaskChildren(instance, instance.root.children));
      canvas.append(svg, content);
      graph.append(canvas);
      graph.addEventListener("scroll", () => {
        this.#graphScrollLeft.set(instance.id, graph.scrollLeft);
        this.#drawGraphLines(graph, instance);
      });
      this.#bindGraphNavigation(graph);
      article.append(graph);
    }
    return article;
  }

  #renderTaskChildren(instance: TodoInstance, children: readonly TodoTask[]): HTMLElement {
    const row = this.#shell.document.createElement("div");
    row.className = "todo-task-groups";
    for (const group of dependencyGroups(children)) {
      const chain = this.#shell.document.createElement("div");
      chain.className = "todo-task-chain";
      group.forEach((task) => {
        chain.append(this.#renderTaskSubtree(instance, task));
      });
      row.append(chain);
    }
    return row;
  }

  #renderTaskSubtree(instance: TodoInstance, task: TodoTask): HTMLElement {
    const subtree = this.#shell.document.createElement("div");
    subtree.className = "todo-task-subtree";
    subtree.dataset.taskId = task.id;
    subtree.classList.toggle("has-children", task.children.length > 0);
    const card = this.#shell.document.createElement("div");
    card.className = "todo-task-node";
    card.dataset.taskId = task.id;
    card.dataset.parentId = this.#findParentId(instance.root, task.id) ?? "";
    card.draggable = true;
    const checkbox = this.#taskCheckbox(instance, task);
    const body = this.#shell.document.createElement("div");
    body.className = "todo-task-node-main";
    const open = this.#shell.document.createElement("button");
    open.type = "button";
    open.className = "todo-task-open";
    open.textContent = task.name;
    open.addEventListener("click", () => this.#openInstanceEditor(instance.id, task.id));
    body.append(checkbox, open);
    card.append(body, this.#progressBar(taskProgress(task)));
    card.addEventListener("dragstart", (event) => {
      this.#draggingTaskId = task.id;
      subtree.classList.add("is-dragging");
      event.dataTransfer?.setData("text/plain", task.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      this.#draggingTaskId = null;
      subtree.classList.remove("is-dragging");
      this.#clearGraphDropTargets();
    });
    card.addEventListener("dragover", (event) => {
      const draggedId = this.#draggingTaskId ?? event.dataTransfer?.getData("text/plain");
      if (!draggedId || draggedId === task.id) return;
      const draggedParentId = this.#findParentId(instance.root, draggedId);
      if (draggedParentId !== card.dataset.parentId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      this.#clearGraphDropTargets();
      subtree.classList.add("is-drop-target");
    });
    card.addEventListener("dragleave", (event) => {
      if (!subtree.contains(event.relatedTarget as Node | null)) subtree.classList.remove("is-drop-target");
    });
    card.addEventListener("drop", (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer?.getData("text/plain") || this.#draggingTaskId;
      this.#draggingTaskId = null;
      this.#clearGraphDropTargets();
      if (draggedId) void this.#reorderGraphTask(instance.id, draggedId, task.id);
    });
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!this.#activeDialog) void this.#deleteGraphTask(instance.id, task.id);
    });
    subtree.append(card);
    if (task.children.length > 0) {
      const nested = this.#shell.document.createElement("div");
      nested.className = "todo-task-children";
      nested.append(this.#renderTaskChildren(instance, task.children));
      subtree.append(nested);
    }
    return subtree;
  }

  #taskCheckbox(instance: TodoInstance, task: TodoTask): HTMLInputElement {
    const checkbox = this.#shell.document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "todo-checkbox";
    checkbox.checked = isTaskComplete(task);
    const predecessor = task.predecessorId ? findTask(instance.root, task.predecessorId) : null;
    const locked = Boolean(predecessor && !isTaskComplete(predecessor));
    checkbox.disabled = task.children.length > 0 || locked || this.#runtime === null;
    checkbox.title = task.children.length > 0
      ? "完成状态由所有子任务决定"
      : locked ? "请先完成前置任务" : "切换完成状态";
    checkbox.setAttribute("aria-label", `${task.name}：${checkbox.title}`);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => void this.#toggleTask(instance, task.id));
    return checkbox;
  }

  #progressBar(progress: number): HTMLElement {
    const bar = this.#shell.document.createElement("div");
    bar.className = "todo-progress";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
    const fill = this.#shell.document.createElement("span");
    fill.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;
    bar.append(fill);
    return bar;
  }

  #renderRules(): void {
    const list = this.#shell.elements.ruleList;
    list.replaceChildren();
    if (this.#payload.rules.length === 0) {
      list.append(this.#empty("还没有周期规则。"));
      return;
    }
    for (const rule of this.#payload.rules) {
      const button = this.#shell.document.createElement("button");
      button.type = "button";
      button.className = "todo-rule-card";
      const copy = this.#shell.document.createElement("span");
      const name = this.#shell.document.createElement("strong");
      name.textContent = rule.template.name;
      const cadence = this.#shell.document.createElement("span");
      cadence.textContent = rule.cadence === "weekly" ? "每周一生成" : "每月一日生成";
      copy.append(name, cadence);
      const edit = this.#shell.document.createElement("span");
      edit.textContent = "编辑";
      button.append(copy, edit);
      button.addEventListener("click", () => {
        this.#closeDialogWithoutSave();
        this.#openRuleEditor(rule.id);
      });
      list.append(button);
    }
  }

  #openRulesManager(): void {
    if (this.#activeDialog) return;
    const dialog = this.#createEditorDialog("周期规则");
    dialog.classList.add("todo-rules-dialog");
    const body = dialog.querySelector<HTMLElement>(".todo-editor-body")!;
    const description = this.#shell.document.createElement("p");
    description.className = "todo-rules-description";
    description.textContent = "选择规则进行编辑。周期规则只影响之后生成的待办。";
    body.append(description, this.#shell.elements.ruleList);
    this.#renderRules();
    this.#dialogBuildEvent = null;
    this.#showDialog(dialog, dialog.querySelector<HTMLButtonElement>("header button")!);
  }

  #openNewTodo(): void {
    const now = new Date();
    const root = createTodoTask(this.#createId(), "新待办");
    const instance: TodoInstance = {
      id: this.#createId(), createdAt: now.toISOString(), reminderAt: now.toISOString(),
      deadlineAt: null, completedAt: null, expanded: false,
      sourceRuleId: null, sourcePeriodKey: null, root,
    };
    this.#openInstanceDraft(instance, true, root.id);
  }

  #openInstanceEditor(instanceId: string, taskId: string): void {
    const instance = this.#payload.instances.find((candidate) => candidate.id === instanceId);
    if (instance) this.#openInstanceDraft(instance, false, taskId);
  }

  #openInstanceDraft(source: TodoInstance, isNew: boolean, taskId: string): void {
    if (this.#activeDialog) return;
    let draft = structuredClone(source) as TodoInstance;
    let selectedId: string | null = null;
    const dialog = this.#createEditorDialog(isNew ? "新建待办" : "编辑待办");
    dialog.classList.add("todo-task-editor-dialog");
    const body = dialog.querySelector<HTMLElement>(".todo-editor-body")!;
    const actions = dialog.querySelector<HTMLElement>(".todo-editor-actions")!;
    const editedTask = findTask(draft.root, taskId);
    if (!editedTask) return;

    const nameField = this.#field("任务名称");
    nameField.input.value = editedTask.name;
    body.append(nameField.label);
    let weightField: TodoFieldElements | null = null;
    if (taskId !== draft.root.id) {
      weightField = this.#field("任务占比", "number");
      weightField.input.step = "any";
      weightField.input.max = "1";
      weightField.input.value = String(editedTask.weight);
      const slider = this.#shell.document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.01";
      slider.value = String(editedTask.weight < 0 ? 0 : editedTask.weight);
      slider.setAttribute("aria-label", "任务占比滑杆");
      const weightControl = this.#shell.document.createElement("div");
      weightControl.className = "todo-weight-control";
      const weightStatus = this.#shell.document.createElement("output");
      weightStatus.className = "todo-weight-status";
      const refreshWeight = (): void => {
        const value = Number(weightField!.input.value);
        const automatic = Number.isFinite(value) && value < 0;
        weightStatus.textContent = automatic
          ? "自动分配"
          : Number.isFinite(value) ? `${Math.round(value * 100)}%` : "无效";
        weightStatus.dataset.automatic = String(automatic);
      };
      slider.addEventListener("input", () => {
        weightField!.input.value = slider.value;
        refreshWeight();
      });
      weightField.input.addEventListener("input", () => {
        const value = Number(weightField!.input.value);
        if (value >= 0 && value <= 1) slider.value = String(value);
        refreshWeight();
      });
      weightControl.append(weightField.input, slider, weightStatus);
      weightField.label.append(weightControl);
      refreshWeight();
      body.append(weightField.label);
    } else {
      body.append(this.#dateEditor(draft, (next) => { draft = next; }));
    }

    const taskArea = this.#shell.document.createElement("section");
    taskArea.className = "todo-editor-tasks";
    const taskHeading = this.#shell.document.createElement("div");
    taskHeading.className = "todo-editor-task-heading";
    const heading = this.#shell.document.createElement("h3");
    heading.textContent = "子任务结构";
    const hint = this.#shell.document.createElement("p");
    hint.textContent = "点击选择；拖动任意节点会移动整条递进链。";
    taskHeading.append(heading, hint);
    const taskList = this.#shell.document.createElement("div");
    taskList.className = "todo-editor-task-list";
    const toolbar = this.#shell.document.createElement("div");
    toolbar.className = "todo-editor-toolbar";
    const parallel = textButton(this.#shell.document, "新增并列", "todos-button secondary", AddOne);
    const successor = textButton(this.#shell.document, "新增递进", "todos-button secondary", ArrowRight);
    const remove = textButton(this.#shell.document, "删除选中", "todos-button danger", Delete);
    toolbar.append(parallel, successor, remove);
    taskArea.append(taskHeading, taskList, toolbar);
    body.append(taskArea);

    const renderDraftTasks = (): void => {
      taskList.replaceChildren();
      const scope = findTask(draft.root, taskId)!;
      if (scope.children.length === 0) taskList.append(this.#empty("暂无子任务。"));
      else taskList.append(this.#editorTaskGroups(scope.children, () => selectedId, (id) => {
        selectedId = id;
        renderDraftTasks();
      }, (dragged, target) => {
        try {
          draft = { ...draft, root: reorderDependencyGroup(draft.root, dragged, target) };
          renderDraftTasks();
        } catch {
          this.#shell.showMessage("依赖组只能在同一层级移动。", "error");
        }
      }));
      successor.disabled = selectedId === null;
      remove.disabled = selectedId === null;
    };
    renderDraftTasks();

    parallel.addEventListener("click", () => {
      const task = createTodoTask(this.#createId());
      const root = selectedId === null
        ? replaceTask(draft.root, taskId, insertParallelTask(findTask(draft.root, taskId)!, null, task))
        : insertParallelTask(draft.root, selectedId, task);
      draft = { ...draft, root };
      selectedId = task.id;
      renderDraftTasks();
    });
    successor.addEventListener("click", () => {
      if (!selectedId) return;
      const task = createTodoTask(this.#createId());
      draft = { ...draft, root: insertSuccessorTask(draft.root, selectedId, task) };
      selectedId = task.id;
      renderDraftTasks();
    });
    remove.addEventListener("click", () => {
      if (!selectedId) return;
      draft = { ...draft, root: deleteTaskAndReconnect(draft.root, selectedId) };
      selectedId = null;
      renderDraftTasks();
    });

    const deleteButton = textButton(this.#shell.document, isNew ? "放弃新建" : "删除任务", "todos-button danger", Delete);
    const saveButton = textButton(this.#shell.document, "保存", "todos-button primary", Save);
    const sourceRule = source.sourceRuleId
      ? this.#payload.rules.find((rule) => rule.id === source.sourceRuleId) ?? null
      : null;
    const overwriteButton = sourceRule
      ? textButton(this.#shell.document, "保存并覆盖周期模板", "todos-button secondary", Save)
      : null;
    actions.append(deleteButton);
    if (overwriteButton) actions.append(overwriteButton);
    actions.append(saveButton);

    const finalizeDraft = (): TodoInstance => {
      const name = nameField.input.value.trim();
      if (!name) throw new TypeError("任务名称不能为空。");
      let root = draft.root;
      const current = findTask(root, taskId)!;
      root = replaceTask(root, taskId, { ...current, name });
      if (weightField) root = setTaskWeight(root, taskId, Number(weightField.input.value));
      const wasComplete = isTaskComplete(source.root);
      const complete = isTaskComplete(root);
      return validateTodosPayload({
        instances: [{
          ...draft,
          root,
          completedAt: complete
            ? wasComplete ? source.completedAt : new Date().toISOString()
            : null,
        }],
        rules: [],
      }).instances[0]!;
    };
    const buildNext = (overwrite = false): TodosPayload => {
      const result = finalizeDraft();
      let next: TodosPayload = {
        ...this.#payload,
        instances: isNew
          ? [...this.#payload.instances, result]
          : this.#payload.instances.map((item) => item.id === result.id ? result : item),
      };
      if (overwrite && sourceRule) {
        const template = cloneTaskWithIds(resetTaskCompletion(result.root), () => this.#createId());
        next = {
          ...next,
          rules: next.rules.map((rule) => rule.id === sourceRule.id ? { ...rule, template } : rule),
        };
      }
      return next;
    };
    const save = async (overwrite = false): Promise<boolean> => {
      try {
        await this.#commitDialog(buildNext(overwrite), overwrite ? "任务和周期模板已保存。" : "任务已保存到本机。");
        return true;
      } catch (error) {
        const focus = !nameField.input.value.trim()
          ? nameField.input
          : weightField && (!Number.isFinite(Number(weightField.input.value)) || Number(weightField.input.value) > 1)
            ? weightField.input
            : nameField.input;
        this.#showEditorError(dialog, safeMessage(error, "任务内容不合法，请检查后重试。"), focus);
        return false;
      }
    };
    this.#dialogBuildEvent = () => {
      const event = createTodosEvent(this.#payload, buildNext(false));
      return event.instances.length || event.rules.length ? event : null;
    };
    saveButton.addEventListener("click", () => void save(false));
    overwriteButton?.addEventListener("click", () => void save(true));
    deleteButton.addEventListener("click", async () => {
      if (!isNew && !await this.#confirm(
        "删除任务？",
        "当前任务及其全部子任务都会被删除。",
        "删除任务",
      )) return;
      if (!isNew) {
        if (taskId === source.root.id) {
          await this.#commitDialog({
            ...this.#payload,
            instances: this.#payload.instances.filter((item) => item.id !== source.id),
          }, "待办已删除。");
        } else {
          const root = deleteTaskAndReconnect(source.root, taskId);
          await this.#commitDialog({
            ...this.#payload,
            instances: this.#payload.instances.map((item) => item.id === source.id
              ? { ...item, root, completedAt: isTaskComplete(root) ? new Date().toISOString() : null }
              : item),
          }, "子任务已删除。");
        }
      } else {
        this.#closeDialogWithoutSave();
      }
    });
    this.#showDialog(dialog, nameField.input);
  }

  #openNewRule(): void {
    const now = new Date();
    const rule: TodoRecurrenceRule = {
      id: this.#createId(),
      createdAt: now.toISOString(),
      cadence: "weekly",
      template: createTodoTask(this.#createId(), "新周期规则"),
      generatedThrough: { weekly: null, monthly: null },
    };
    this.#openRuleDraft(rule, true);
  }

  #openRuleEditor(ruleId: string): void {
    const rule = this.#payload.rules.find((candidate) => candidate.id === ruleId);
    if (rule) this.#openRuleDraft(rule, false);
  }

  #openRuleDraft(source: TodoRecurrenceRule, isNew: boolean): void {
    if (this.#activeDialog) return;
    let draft = structuredClone(source) as TodoRecurrenceRule;
    let selectedId: string | null = null;
    const dialog = this.#createEditorDialog(isNew ? "新建周期规则" : "编辑周期规则");
    dialog.classList.add("todo-task-editor-dialog");
    const body = dialog.querySelector<HTMLElement>(".todo-editor-body")!;
    const actions = dialog.querySelector<HTMLElement>(".todo-editor-actions")!;
    const nameField = this.#field("规则与任务名称");
    nameField.input.value = draft.template.name;
    const cadence = this.#shell.document.createElement("fieldset");
    cadence.className = "todo-cadence";
    const legend = this.#shell.document.createElement("legend");
    legend.textContent = "生成周期";
    const weekly = radio(this.#shell.document, "每周任务", "weekly", draft.cadence === "weekly");
    const monthly = radio(this.#shell.document, "每月任务", "monthly", draft.cadence === "monthly");
    weekly.input.name = monthly.input.name = `cadence-${source.id}`;
    cadence.append(legend, weekly.label, monthly.label);
    body.append(nameField.label, cadence);

    const taskArea = this.#shell.document.createElement("section");
    taskArea.className = "todo-editor-tasks";
    const taskHeading = this.#shell.document.createElement("div");
    taskHeading.className = "todo-editor-task-heading";
    const heading = this.#shell.document.createElement("h3");
    heading.textContent = "模板子任务";
    const hint = this.#shell.document.createElement("p");
    hint.textContent = "选择后可新增递进任务或删除。";
    taskHeading.append(heading, hint);
    const list = this.#shell.document.createElement("div");
    list.className = "todo-editor-task-list";
    const toolbar = this.#shell.document.createElement("div");
    toolbar.className = "todo-editor-toolbar";
    const parallel = textButton(this.#shell.document, "新增并列", "todos-button secondary", AddOne);
    const successor = textButton(this.#shell.document, "新增递进", "todos-button secondary", ArrowRight);
    const remove = textButton(this.#shell.document, "删除选中", "todos-button danger", Delete);
    toolbar.append(parallel, successor, remove);
    taskArea.append(taskHeading, list, toolbar);
    body.append(taskArea);
    const render = (): void => {
      list.replaceChildren();
      if (draft.template.children.length === 0) list.append(this.#empty("暂无模板子任务。"));
      else list.append(this.#editorTaskGroups(
        draft.template.children, () => selectedId, (id) => { selectedId = id; render(); },
        (dragged, target) => {
          draft = { ...draft, template: reorderDependencyGroup(draft.template, dragged, target) };
          render();
        },
      ));
      successor.disabled = selectedId === null;
      remove.disabled = selectedId === null;
    };
    render();
    parallel.addEventListener("click", () => {
      const task = createTodoTask(this.#createId());
      draft = { ...draft, template: insertParallelTask(draft.template, selectedId, task) };
      selectedId = task.id;
      render();
    });
    successor.addEventListener("click", () => {
      if (!selectedId) return;
      const task = createTodoTask(this.#createId());
      draft = { ...draft, template: insertSuccessorTask(draft.template, selectedId, task) };
      selectedId = task.id;
      render();
    });
    remove.addEventListener("click", () => {
      if (!selectedId) return;
      draft = { ...draft, template: deleteTaskAndReconnect(draft.template, selectedId) };
      selectedId = null;
      render();
    });

    const deleteButton = textButton(this.#shell.document, isNew ? "放弃新建" : "删除规则", "todos-button danger", Delete);
    const saveButton = textButton(this.#shell.document, "保存规则", "todos-button primary", Save);
    actions.append(deleteButton, saveButton);
    const buildNext = (): TodosPayload => {
      const name = nameField.input.value.trim();
      if (!name) throw new TypeError("规则名称不能为空。");
      const selectedCadence = weekly.input.checked ? "weekly" : "monthly";
      const template = { ...draft.template, name };
      let rule: TodoRecurrenceRule = { ...draft, cadence: selectedCadence, template };
      let generated: TodoInstance | null = null;
      if (isNew || selectedCadence !== source.cadence) {
        const initialized = initializeRulePeriod(rule, new Date(), () => this.#createId());
        rule = initialized.rule;
        generated = initialized.instance;
      }
      return {
        instances: generated ? [...this.#payload.instances, generated] : this.#payload.instances,
        rules: isNew
          ? [...this.#payload.rules, rule]
          : this.#payload.rules.map((item) => item.id === rule.id ? rule : item),
      };
    };
    const save = async (): Promise<boolean> => {
      try {
        await this.#commitDialog(buildNext(), "周期规则已保存。");
        return true;
      } catch (error) {
        this.#showEditorError(dialog, safeMessage(error, "周期规则不合法。"), nameField.input);
        return false;
      }
    };
    this.#dialogBuildEvent = () => {
      const event = createTodosEvent(this.#payload, buildNext());
      return event.instances.length || event.rules.length ? event : null;
    };
    saveButton.addEventListener("click", () => void save());
    deleteButton.addEventListener("click", async () => {
      if (!isNew && !await this.#confirm(
        "删除周期规则？",
        "规则将停止生成新待办，已经生成的任务会保留。",
        "删除规则",
      )) return;
      if (!isNew) {
        await this.#commitDialog({
          ...this.#payload,
          rules: this.#payload.rules.filter((rule) => rule.id !== source.id),
        }, "周期规则已删除，已有任务保持不变。");
      } else {
        this.#closeDialogWithoutSave();
      }
    });
    this.#showDialog(dialog, nameField.input);
  }

  #dateEditor(source: TodoInstance, update: (value: TodoInstance) => void): HTMLElement {
    let current = source;
    const section = this.#shell.document.createElement("section");
    section.className = "todo-date-editor";
    const reminder = this.#dateSummary("提醒日期", current.reminderAt);
    const deadline = this.#dateSummary("截止日期", current.deadlineAt);
    const refresh = (): void => {
      reminder.value.textContent = formatDisplayDate(current.reminderAt);
      deadline.value.textContent = current.deadlineAt === null ? "无限远" : formatDisplayDate(current.deadlineAt);
    };
    reminder.button.addEventListener("click", async () => {
      const dates = await this.#chooseDate("reminder", current);
      if (!dates) return;
      current = { ...current, ...dates };
      update(current);
      refresh();
    });
    deadline.button.addEventListener("click", async () => {
      const dates = await this.#chooseDate("deadline", current);
      if (!dates) return;
      current = { ...current, ...dates };
      update(current);
      refresh();
    });
    section.append(reminder.button, deadline.button);
    return section;
  }

  #dateSummary(label: string, date: string | null): {
    button: HTMLButtonElement;
    value: HTMLElement;
  } {
    const button = this.#shell.document.createElement("button");
    button.type = "button";
    button.className = "todo-date-summary";
    const heading = this.#shell.document.createElement("strong");
    heading.textContent = label;
    const value = this.#shell.document.createElement("span");
    value.textContent = date === null ? "无限远" : formatDisplayDate(date);
    button.append(heading, value, createTodoIcon(this.#shell.document, ArrowRight, 17));
    return { button, value };
  }

  #chooseDate(
    role: "reminder" | "deadline",
    instance: TodoInstance,
  ): Promise<{ reminderAt: string; deadlineAt: string | null } | null> {
    const dialog = this.#shell.document.createElement("dialog");
    dialog.className = "todo-date-dialog";
    const panel = this.#shell.document.createElement("div");
    panel.className = "todo-dialog-panel";
    const title = this.#shell.document.createElement("h2");
    title.textContent = role === "reminder" ? "设置提醒日期" : "设置截止日期";
    title.tabIndex = -1;
    const specificField = this.#shell.document.createElement("div");
    specificField.className = "todo-date-field";
    const specificHeading = this.#shell.document.createElement("span");
    specificHeading.textContent = "具体日期";
    const specific = this.#shell.document.createElement("input");
    specific.type = "text";
    specific.inputMode = "numeric";
    specific.maxLength = 12;
    specific.value = formatTodoDateInput(role === "reminder" ? instance.reminderAt : instance.deadlineAt);
    specific.placeholder = "YYYYMMDDHHmm 或负数";
    specific.setAttribute("aria-label", "具体日期");
    specificField.append(specificHeading, specific);
    const separator = this.#shell.document.createElement("span");
    separator.className = "todo-date-or";
    separator.textContent = "或";
    const relativeField = this.#shell.document.createElement("div");
    relativeField.className = "todo-date-field";
    const relativeHeading = this.#shell.document.createElement("span");
    relativeHeading.textContent = role === "reminder" ? "距离截止日期的天数" : "距离提醒日期的天数";
    const relative = this.#shell.document.createElement("input");
    relative.type = "number";
    relative.min = "0";
    relative.step = "1";
    relative.placeholder = "非负整数";
    relative.setAttribute("aria-label", relativeHeading.textContent);
    relativeField.append(relativeHeading, relative);
    const error = this.#shell.document.createElement("p");
    error.className = "todo-editor-error";
    error.hidden = true;
    error.setAttribute("role", "alert");
    const actions = this.#shell.document.createElement("div");
    actions.className = "todo-date-dialog-actions";
    const confirm = textButton(this.#shell.document, "确认", "todos-button primary");
    const cancel = textButton(this.#shell.document, "取消", "todos-button subtle");
    actions.append(confirm, cancel);
    panel.append(title, specificField, separator, relativeField, error, actions);
    dialog.append(panel);
    this.#shell.elements.root.append(dialog);
    let mode: "specific" | "relative" = "specific";
    specific.addEventListener("input", () => {
      mode = "specific";
      specific.value = sanitizeSpecificInput(specific.value);
    });
    relative.addEventListener("input", () => { mode = "relative"; });
    dialog.showModal();
    title.focus();
    return new Promise((resolve) => {
      const finish = (value: { reminderAt: string; deadlineAt: string | null } | null): void => {
        dialog.close();
        dialog.remove();
        resolve(value);
      };
      const cancelChoice = (): void => finish(null);
      cancel.addEventListener("click", cancelChoice);
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        cancelChoice();
      });
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) cancelChoice();
      });
      confirm.addEventListener("click", () => {
        try {
          if (mode === "specific") {
            const parsed = parseTodoSpecificDate(specific.value, role, new Date());
            finish(role === "reminder"
              ? reconcileTodoDates(parsed!, instance.deadlineAt, role)
              : reconcileTodoDates(instance.reminderAt, parsed, role));
            return;
          }
          const days = Number(relative.value);
          if (role === "reminder") {
            if (instance.deadlineAt === null) throw new TypeError("截止日期为无限远时不能反推提醒日期。");
            finish({
              reminderAt: reminderFromDeadline(instance.deadlineAt, days),
              deadlineAt: instance.deadlineAt,
            });
          } else {
            finish({
              reminderAt: instance.reminderAt,
              deadlineAt: deadlineFromReminder(instance.reminderAt, days),
            });
          }
        } catch (caught) {
          error.textContent = safeMessage(caught, "日期设置无效。");
          error.hidden = false;
        }
      });
    });
  }

  #editorTaskGroups(
    children: readonly TodoTask[],
    selected: () => string | null,
    select: (id: string) => void,
    reorder: (dragged: string, target: string) => void,
  ): HTMLElement {
    const groups = this.#shell.document.createElement("div");
    groups.className = "todo-editor-task-groups";
    for (const group of dependencyGroups(children)) {
      const chain = this.#shell.document.createElement("div");
      chain.className = "todo-editor-task-chain";
      group.forEach((task, index) => {
        if (index > 0) {
          const arrow = this.#shell.document.createElement("span");
          arrow.className = "todo-editor-task-arrow";
          arrow.setAttribute("aria-hidden", "true");
          arrow.append(createTodoIcon(this.#shell.document, ArrowRight, 20));
          chain.append(arrow);
        }
        chain.append(this.#editorTaskRow(task, selected, select, reorder));
      });
      groups.append(chain);
    }
    return groups;
  }

  #editorTaskRow(
    task: TodoTask,
    selected: () => string | null,
    select: (id: string) => void,
    reorder: (dragged: string, target: string) => void,
  ): HTMLElement {
    const row = this.#shell.document.createElement("button");
    row.type = "button";
    row.className = "todo-editor-task-row";
    row.dataset.selected = String(selected() === task.id);
    row.draggable = true;
    row.append(createTodoIcon(this.#shell.document, Drag, 18));
    const name = this.#shell.document.createElement("span");
    name.textContent = task.name;
    row.append(name);
    row.addEventListener("click", () => select(task.id));
    row.addEventListener("dragstart", (event) => {
      this.#draggingTaskId = task.id;
      event.dataTransfer?.setData("text/plain", task.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      this.#draggingTaskId = null;
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const dragged = event.dataTransfer?.getData("text/plain") || this.#draggingTaskId;
      this.#draggingTaskId = null;
      if (dragged) reorder(dragged, task.id);
    });
    return row;
  }

  #confirm(titleText: string, messageText: string, confirmLabel: string): Promise<boolean> {
    const dialog = this.#shell.document.createElement("dialog");
    dialog.className = "todo-confirm-dialog";
    const panel = this.#shell.document.createElement("div");
    panel.className = "todo-dialog-panel";
    const title = this.#shell.document.createElement("h2");
    title.textContent = titleText;
    const message = this.#shell.document.createElement("p");
    message.textContent = messageText;
    const actions = this.#shell.document.createElement("div");
    actions.className = "todo-confirm-actions";
    const cancel = textButton(this.#shell.document, "取消", "todos-button subtle");
    const confirm = textButton(this.#shell.document, confirmLabel, "todos-button danger");
    actions.append(cancel, confirm);
    panel.append(title, message, actions);
    dialog.append(panel);
    this.#shell.elements.root.append(dialog);
    dialog.showModal();
    cancel.focus();
    return new Promise((resolve) => {
      const finish = (value: boolean): void => {
        dialog.close();
        dialog.remove();
        resolve(value);
      };
      cancel.addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(false);
      });
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) finish(false);
      });
    });
  }

  #createEditorDialog(titleText: string): HTMLDialogElement {
    const dialog = this.#shell.document.createElement("dialog");
    dialog.className = "todo-editor";
    const header = this.#shell.document.createElement("header");
    const title = this.#shell.document.createElement("h2");
    title.textContent = titleText;
    const close = closeButton(this.#shell.document, "取消");
    close.addEventListener("click", () => this.#closeDialogWithoutSave());
    header.append(title, close);
    const error = this.#shell.document.createElement("p");
    error.className = "todo-editor-error";
    error.hidden = true;
    error.setAttribute("role", "alert");
    const body = this.#shell.document.createElement("div");
    body.className = "todo-editor-body";
    const actions = this.#shell.document.createElement("footer");
    actions.className = "todo-editor-actions";
    dialog.append(header, error, body, actions);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.#closeDialogWithoutSave();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) this.#closeDialogWithoutSave();
    });
    this.#shell.elements.root.append(dialog);
    return dialog;
  }

  #showDialog(dialog: HTMLDialogElement, focus: HTMLElement): void {
    this.#activeDialog = dialog;
    this.#renderCommandState();
    dialog.showModal();
    this.#window.queueMicrotask(() => {
      focus.focus();
    });
  }

  #closeDialogWithoutSave(): void {
    const dialog = this.#activeDialog;
    this.#activeDialog = null;
    this.#dialogBuildEvent = null;
    this.#draggingTaskId = null;
    if (dialog) {
      dialog.close();
      dialog.remove();
    }
    this.#renderCommandState();
  }

  #showEditorError(dialog: HTMLDialogElement, message: string, focus?: HTMLInputElement): void {
    const error = dialog.querySelector<HTMLElement>(".todo-editor-error");
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
    if (focus) {
      focus.setAttribute("aria-invalid", "true");
      focus.focus();
      focus.addEventListener("input", () => focus.removeAttribute("aria-invalid"), { once: true });
    }
  }

  #field(labelText: string, type: HTMLInputElement["type"] = "text"): TodoFieldElements {
    const label = this.#shell.document.createElement("label");
    label.className = "todo-field";
    const text = this.#shell.document.createElement("span");
    text.textContent = labelText;
    const input = this.#shell.document.createElement("input");
    input.type = type;
    input.autocomplete = "off";
    label.append(text, input);
    return { label, input };
  }

  async #toggleTask(instance: TodoInstance, taskId: string): Promise<void> {
    try {
      const nextInstance = toggleTodoLeaf(instance, taskId, new Date());
      await this.#commit({
        ...this.#payload,
        instances: this.#payload.instances.map((item) => item.id === instance.id ? nextInstance : item),
      }, null);
    } catch (error) {
      this.#shell.showMessage(safeMessage(error, "完成状态未能更新。"), "error");
      this.#renderInstances();
    }
  }

  async #reorderGraphTask(instanceId: string, draggedId: string, targetId: string): Promise<void> {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    if (!instance) return;
    try {
      const root = reorderDependencyGroup(instance.root, draggedId, targetId);
      await this.#commit({
        ...this.#payload,
        instances: this.#payload.instances.map((item) => item.id === instanceId ? { ...item, root } : item),
      }, null);
    } catch (error) {
      this.#shell.showMessage(safeMessage(error, "只能调整同一父任务下的任务组。"), "error");
      this.#renderInstances();
    }
  }

  async #deleteGraphTask(instanceId: string, taskId: string): Promise<void> {
    const instance = this.#payload.instances.find((item) => item.id === instanceId);
    const task = instance ? findTask(instance.root, taskId) : null;
    if (!instance || !task) return;
    if (!await this.#confirm(
      "删除子任务？",
      `“${task.name}”及其全部子任务都会被删除。`,
      "删除子任务",
    )) return;
    const root = deleteTaskAndReconnect(instance.root, taskId);
    await this.#commit({
      ...this.#payload,
      instances: this.#payload.instances.map((item) => item.id === instanceId
        ? { ...item, root, completedAt: isTaskComplete(root) ? new Date().toISOString() : null }
        : item),
    }, null);
  }

  async #setExpanded(instance: TodoInstance, expanded: boolean): Promise<void> {
    await this.#commit({
      ...this.#payload,
      instances: this.#payload.instances.map((item) => item.id === instance.id
        ? { ...item, expanded }
        : item),
    }, null);
  }

  async #commit(nextValue: TodosPayload, _message: string | null): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) return;
    const next = validateTodosPayload(nextValue);
    const event = createTodosEvent(this.#payload, next);
    if (event.instances.length === 0 && event.rules.length === 0) return;
    try {
      this.#payload = runtime.dispatch(event);
      this.#renderAll();
      await runtime.save();
      this.#localSaveFailed = false;
      this.#renderSnapshot();
    } catch {
      this.#localSaveFailed = true;
      this.#renderSnapshot();
      this.#shell.showMessage("自动保存失败，当前页面内容仍然保留。", "error");
    }
  }

  async #commitDialog(nextValue: TodosPayload, message: string | null): Promise<void> {
    const next = validateTodosPayload(nextValue);
    this.#closeDialogWithoutSave();
    await this.#commit(next, message);
  }

  async #retrySave(): Promise<void> {
    if (this.#activeDialog) return;
    try {
      await this.#runtime?.save();
      this.#localSaveFailed = false;
      this.#renderSnapshot();
    } catch {
      this.#localSaveFailed = true;
      this.#renderSnapshot();
    }
  }

  async #undo(): Promise<void> {
    if (!this.#runtime?.canUndo || this.#activeDialog) return;
    try {
      this.#payload = await this.#runtime.undo();
      this.#renderAll();
      await this.#runtime.save();
    } catch {
      this.#shell.showMessage("撤销未能完成。", "error");
    }
  }

  async #redo(): Promise<void> {
    if (!this.#runtime?.canRedo || this.#activeDialog) return;
    try {
      this.#payload = await this.#runtime.redo();
      this.#renderAll();
      await this.#runtime.save();
    } catch {
      this.#shell.showMessage("重做未能完成。", "error");
    }
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.#activeDialog) {
      const openDialogs = [...this.#shell.document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
      const topDialog = openDialogs[openDialogs.length - 1];
      event.preventDefault();
      if (topDialog && topDialog !== this.#activeDialog) {
        topDialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      } else {
        this.#closeDialogWithoutSave();
      }
      return;
    }
    if (event.defaultPrevented || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
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
      }, `已补建 ${generated.instances.length} 个周期待办。`);
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

  #scheduleGraphLines(): void {
    this.#window.requestAnimationFrame(() => {
      for (const instance of this.#payload.instances) {
        const graph = this.#shell.elements.todoList.querySelector<HTMLElement>(
          `.todo-graph[data-instance-id="${instance.id}"]`,
        );
        if (graph) {
          graph.scrollLeft = this.#graphScrollLeft.get(instance.id) ?? 0;
          this.#drawGraphLines(graph, instance);
        }
      }
    });
  }

  #bindGraphNavigation(graph: HTMLElement): void {
    graph.addEventListener("wheel", (event) => {
      if (graph.scrollWidth <= graph.clientWidth) return;
      const movement = event.deltaX + event.deltaY;
      if (movement === 0) return;
      event.preventDefault();
      graph.scrollLeft += movement;
    }, { passive: false });

    let pointerId: number | null = null;
    let startX = 0;
    let startScrollLeft = 0;
    graph.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest(".todo-task-node")) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startScrollLeft = graph.scrollLeft;
      graph.classList.add("is-panning");
      graph.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    graph.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) return;
      graph.scrollLeft = startScrollLeft - (event.clientX - startX);
    });
    const finishPan = (event: PointerEvent): void => {
      if (pointerId !== event.pointerId) return;
      if (graph.hasPointerCapture(event.pointerId)) graph.releasePointerCapture(event.pointerId);
      pointerId = null;
      graph.classList.remove("is-panning");
    };
    graph.addEventListener("pointerup", finishPan);
    graph.addEventListener("pointercancel", finishPan);
  }

  #clearGraphDropTargets(): void {
    for (const target of this.#shell.elements.todoList.querySelectorAll(".todo-task-subtree.is-drop-target")) {
      target.classList.remove("is-drop-target");
    }
  }

  #drawGraphLines(graph: HTMLElement, instance: TodoInstance): void {
    const svg = graph.querySelector<SVGSVGElement>(".todo-graph-lines");
    const canvas = graph.querySelector<HTMLElement>(".todo-graph-canvas");
    if (!svg || !canvas) return;
    const width = Math.max(canvas.scrollWidth, graph.clientWidth);
    const height = Math.max(canvas.scrollHeight, graph.clientHeight);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren();
    const defs = this.#shell.document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = this.#shell.document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", `todo-arrow-${instance.id}`);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "4");
    marker.setAttribute("orient", "auto");
    const arrow = this.#shell.document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", "M0,0 L8,4 L0,8 Z");
    arrow.setAttribute("fill", "#168a53");
    marker.append(arrow);
    defs.append(marker);
    svg.append(defs);
    const base = canvas.getBoundingClientRect();
    const node = (id: string) => canvas.querySelector<HTMLElement>(`.todo-task-node[data-task-id="${id}"]`);
    const dependencyBox = (id: string): HTMLElement | null => {
      const subtree = canvas.querySelector<HTMLElement>(`.todo-task-subtree[data-task-id="${id}"]`);
      return subtree?.classList.contains("has-children") ? subtree : node(id);
    };
    const point = (element: HTMLElement, side: "top" | "bottom" | "left" | "right") => {
      const rect = element.getBoundingClientRect();
      const x = side === "left" ? rect.left : side === "right" ? rect.right : rect.left + rect.width / 2;
      const y = side === "top" ? rect.top : side === "bottom" ? rect.bottom : rect.top + rect.height / 2;
      return { x: x - base.left, y: y - base.top };
    };
    const addPath = (from: { x: number; y: number }, to: { x: number; y: number }, arrowed: boolean) => {
      const path = this.#shell.document.createElementNS("http://www.w3.org/2000/svg", "path");
      const horizontal = Math.abs(to.x - from.x) > Math.abs(to.y - from.y);
      path.setAttribute("d", horizontal
        ? `M${from.x},${from.y} H${(from.x + to.x) / 2} V${to.y} H${to.x}`
        : `M${from.x},${from.y} V${(from.y + to.y) / 2} H${to.x} V${to.y}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", arrowed ? "#168a53" : "#9aa8a0");
      path.setAttribute("stroke-width", "2");
      if (arrowed) path.setAttribute("marker-end", `url(#todo-arrow-${instance.id})`);
      svg.append(path);
    };
    const addParentBus = (
      parentNode: HTMLElement,
      childNodes: readonly HTMLElement[],
    ): void => {
      if (childNodes.length === 0) return;
      const from = point(parentNode, "bottom");
      const targets = childNodes.map((childNode) => point(childNode, "top"));
      const firstChildY = Math.min(...targets.map((target) => target.y));
      const busY = from.y + (firstChildY - from.y) / 2;
      const left = Math.min(...targets.map((target) => target.x));
      const right = Math.max(...targets.map((target) => target.x));
      const path = this.#shell.document.createElementNS("http://www.w3.org/2000/svg", "path");
      const branches = targets.map((target) => `M${target.x},${busY} V${target.y}`).join(" ");
      path.setAttribute("d", `M${from.x},${from.y} V${busY} M${left},${busY} H${right} ${branches}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#9aa8a0");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linejoin", "round");
      svg.append(path);
    };
    const visit = (parent: TodoTask): void => {
      const parentNode = parent.id === instance.root.id ? null : node(parent.id);
      if (parentNode) {
        const childBoxes = parent.children
          .map((child) => dependencyBox(child.id))
          .filter((childBox): childBox is HTMLElement => childBox !== null);
        addParentBus(parentNode, childBoxes);
      }
      for (const child of parent.children) {
        if (child.predecessorId) {
          const predecessor = dependencyBox(child.predecessorId);
          const successor = dependencyBox(child.id);
          if (predecessor && successor) addPath(point(predecessor, "right"), point(successor, "left"), true);
        }
        visit(child);
      }
    };
    visit(instance.root);
  }

  #findParentId(root: TodoTask, taskId: string): string | null {
    if (root.children.some((child) => child.id === taskId)) return root.id;
    for (const child of root.children) {
      const found = this.#findParentId(child, taskId);
      if (found) return found;
    }
    return null;
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

function radio(document: Document, labelText: string, value: string, checked: boolean): {
  label: HTMLLabelElement;
  input: HTMLInputElement;
} {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.value = value;
  input.checked = checked;
  label.append(input, document.createTextNode(labelText));
  return { label, input };
}

function sanitizeSpecificInput(value: string): string {
  if (value.startsWith("-")) return `-${value.slice(1).replace(/\D/gu, "")}`;
  return value.replace(/\D/gu, "");
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
