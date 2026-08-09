import { Delete, Save } from "@icon-park/svg";
import {
  cloneTaskWithIds,
  createTodoTask,
  createTodosEvent,
  deleteTaskAndReconnect,
  findTask,
  insertParallelTask,
  insertSuccessorTask,
  isTaskComplete,
  reorderDependencyGroup,
  replaceTask,
  resetTaskCompletion,
  setTaskWeight,
  validateTodosPayload,
  type TodoInstance,
  type TodosEvent,
  type TodosPayload,
} from "../domain";
import type { TodoConfirmationOptions } from "./confirmDialog";
import { TodoDateEditor } from "./dateEditor";
import {
  createEditorField,
  createWeightEditorField,
  safeEditorMessage,
  TodoEditorDialog,
  type TodoEditorField,
} from "./editorDialog";
import { textButton } from "./shell";
import { TaskStructureEditor } from "./taskStructureEditor";

export interface TodoInstanceEditorOptions {
  readonly mount: HTMLElement;
  readonly baseline: TodoInstance;
  readonly draft?: TodoInstance;
  readonly taskId: string;
  readonly isNew: boolean;
  readonly trigger?: HTMLElement | null;
  readonly createId: () => string;
  readonly getPayload: () => TodosPayload;
  readonly commit: (next: TodosPayload) => Promise<boolean>;
  readonly confirm: (options: TodoConfirmationOptions) => Promise<boolean>;
  readonly requestClose: () => void;
  readonly openTask: (draft: TodoInstance, taskId: string) => void;
  readonly bindStructure: (
    editor: TaskStructureEditor,
    reorder: (draggedGroupId: string, beforeGroupId: string | null) => void,
  ) => void;
  readonly showMessage?: (message: string, tone: "normal" | "success" | "error") => void;
  readonly now?: () => Date;
}

export type TodoInstanceSaveIntent = "save" | "overwrite-template";

/** Complete instance-draft workflow. It owns draft/form state, never Runtime or payload state. */
export class TodoInstanceEditor {
  readonly dialog: TodoEditorDialog;
  readonly structureEditor: TaskStructureEditor;
  readonly trigger: HTMLElement | null;

  readonly #options: TodoInstanceEditorOptions;
  readonly #baseline: TodoInstance;
  readonly #taskId: string;
  readonly #isNew: boolean;
  readonly #nameField: TodoEditorField;
  readonly #weightField: TodoEditorField | null;
  readonly #dateEditor: TodoDateEditor | null;
  readonly #now: () => Date;
  #draft: TodoInstance;
  #selectedTaskId: string | null = null;
  #busy = false;
  #disposed = false;

  constructor(document: Document, options: TodoInstanceEditorOptions) {
    this.#options = options;
    this.#baseline = structuredClone(options.baseline) as TodoInstance;
    this.#draft = structuredClone(options.draft ?? options.baseline) as TodoInstance;
    this.#taskId = options.taskId;
    this.#isNew = options.isNew;
    this.#now = options.now ?? (() => new Date());
    const editedTask = findTask(this.#draft.root, this.#taskId);
    if (!editedTask) throw new TypeError("待编辑任务不存在。");

    this.dialog = new TodoEditorDialog(document, {
      mount: options.mount,
      title: options.isNew ? "新建待办" : "编辑待办",
      trigger: options.trigger,
      classNames: "todo-task-editor-dialog",
      onCancel: options.requestClose,
      canCancel: () => !this.#busy,
    });
    this.trigger = this.dialog.trigger;

    this.#nameField = createEditorField(document, "任务名称");
    this.#nameField.input.value = editedTask.name;
    this.dialog.body.append(this.#nameField.label);

    if (this.#taskId !== this.#draft.root.id) {
      this.#weightField = createWeightEditorField(document, editedTask.weight);
      this.#dateEditor = null;
      this.dialog.body.append(this.#weightField.label);
    } else {
      this.#weightField = null;
      this.#dateEditor = new TodoDateEditor(document, {
        mount: options.mount,
        value: this.#draft,
        onChange: (value) => {
          this.#draft = { ...this.#draft, ...value };
        },
        now: this.#now,
        canCancel: () => !this.#busy,
      });
      this.dialog.body.append(this.#dateEditor.element);
    }

    this.structureEditor = new TaskStructureEditor(document, {
      kind: "instance",
      callbacks: {
        onOpenTask: (taskId) => this.#openTask(taskId),
        onSelectTask: (taskId) => { this.#selectedTaskId = taskId; },
        onAddParallel: (selection) => this.#addParallel(selection),
        onAddSuccessor: (selection) => this.#addSuccessor(selection),
        onDeleteTask: (selection) => void this.#deleteSelectedChild(selection),
      },
    });
    this.dialog.body.append(this.structureEditor.element);
    this.#renderStructure();

    const cancel = textButton(
      document,
      options.isNew ? "放弃新建" : "取消",
      "todos-button subtle",
    );
    const sourceRule = this.#baseline.sourceRuleId
      ? options.getPayload().rules.find((rule) => rule.id === this.#baseline.sourceRuleId) ?? null
      : null;
    const overwrite = sourceRule
      ? textButton(document, "保存并覆盖周期模板", "todos-button secondary", Save)
      : null;
    const save = textButton(document, "保存", "todos-button primary", Save);
    const remove = !options.isNew
      ? textButton(document, "删除任务", "todos-button danger", Delete)
      : null;
    this.dialog.actions.append(cancel);
    if (overwrite) this.dialog.actions.append(overwrite);
    this.dialog.actions.append(save);
    if (remove) this.dialog.actions.append(remove);

    cancel.addEventListener("click", options.requestClose);
    overwrite?.addEventListener("click", () => void this.save("overwrite-template"));
    save.addEventListener("click", () => void this.save("save"));
    remove?.addEventListener("click", () => void this.delete(remove));
  }

  open(): void {
    this.dialog.open(this.#nameField.input);
  }

  buildNext(payload: TodosPayload, intent: TodoInstanceSaveIntent = "save"): TodosPayload {
    const result = this.#finalizeDraft();
    let next: TodosPayload = {
      ...payload,
      instances: this.#isNew
        ? [...payload.instances, result]
        : payload.instances.map((instance) => instance.id === result.id ? result : instance),
    };
    if (intent === "overwrite-template" && this.#baseline.sourceRuleId) {
      const sourceRule = next.rules.find((rule) => rule.id === this.#baseline.sourceRuleId);
      if (sourceRule) {
        const template = cloneTaskWithIds(resetTaskCompletion(result.root), this.#options.createId);
        next = {
          ...next,
          rules: next.rules.map((rule) => rule.id === sourceRule.id ? { ...rule, template } : rule),
        };
      }
    }
    return validateTodosPayload(next);
  }

  settle(payload: TodosPayload): TodosEvent | null {
    const next = this.buildNext(payload, "save");
    const event = createTodosEvent(payload, next);
    return event.instances.length || event.rules.length ? event : null;
  }

  async save(intent: TodoInstanceSaveIntent = "save"): Promise<boolean> {
    if (this.#busy || this.#disposed) return false;
    let next: TodosPayload;
    try {
      next = this.buildNext(this.#options.getPayload(), intent);
    } catch (error) {
      this.#showValidationError(error);
      return false;
    }
    return this.#commit(next, intent === "overwrite-template" ? "正在覆盖模板…" : "正在保存…");
  }

  async delete(trigger?: HTMLElement): Promise<boolean> {
    if (this.#busy || this.#disposed || this.#isNew) return false;
    const confirmed = await this.#options.confirm({
      title: "删除任务？",
      message: "当前任务及其全部子任务都会被删除。",
      confirmLabel: "删除任务",
      trigger,
      canCancel: () => !this.#busy,
    });
    if (!confirmed || this.#disposed) return false;
    const next = this.#buildDeletion(this.#options.getPayload());
    return this.#commit(next, "正在删除…");
  }

  setDisabled(disabled: boolean): void {
    if (this.#disposed) return;
    this.#nameField.input.disabled = disabled;
    if (this.#weightField) {
      for (const input of this.#weightField.label.querySelectorAll("input")) input.disabled = disabled;
    }
    this.#dateEditor?.setDisabled(disabled);
    this.structureEditor.setDisabled(disabled);
  }

  dispose(restoreFocus = true): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#busy = false;
    this.#dateEditor?.dispose();
    this.structureEditor.dispose();
    this.dialog.dispose(restoreFocus);
  }

  #finalizeDraft(): TodoInstance {
    const name = this.#nameField.input.value.trim();
    if (!name) throw new TypeError("任务名称不能为空。");
    let root = this.#draft.root;
    const current = findTask(root, this.#taskId);
    if (!current) throw new TypeError("待编辑任务不存在。");
    root = replaceTask(root, this.#taskId, { ...current, name });
    if (this.#weightField) {
      root = setTaskWeight(root, this.#taskId, Number(this.#weightField.input.value));
    }
    const wasComplete = isTaskComplete(this.#baseline.root);
    const complete = isTaskComplete(root);
    const result: TodoInstance = {
      ...this.#draft,
      root,
      completedAt: complete
        ? wasComplete ? this.#baseline.completedAt : this.#now().toISOString()
        : null,
    };
    return validateTodosPayload({ instances: [result], rules: [] }).instances[0]!;
  }

  #buildDeletion(payload: TodosPayload): TodosPayload {
    if (this.#taskId === this.#draft.root.id) {
      return validateTodosPayload({
        ...payload,
        instances: payload.instances.filter((instance) => instance.id !== this.#baseline.id),
      });
    }
    const root = deleteTaskAndReconnect(this.#draft.root, this.#taskId);
    const result: TodoInstance = {
      ...this.#draft,
      root,
      completedAt: isTaskComplete(root) ? this.#now().toISOString() : null,
    };
    return validateTodosPayload({
      ...payload,
      instances: payload.instances.map((instance) => instance.id === result.id ? result : instance),
    });
  }

  async #commit(next: TodosPayload, stage: string): Promise<boolean> {
    this.#setBusy(true, stage);
    try {
      const committed = await this.#options.commit(next);
      if (this.#disposed) return committed;
      if (committed) {
        this.#options.requestClose();
        return true;
      }
      this.#setBusy(false);
      this.dialog.showError("操作未完成，请重试。");
      return false;
    } catch (error) {
      if (!this.#disposed) {
        this.#setBusy(false);
        this.dialog.showError(safeEditorMessage(error, "操作未完成，请重试。"));
      }
      return false;
    }
  }

  #setBusy(busy: boolean, stage = ""): void {
    this.#busy = busy;
    this.dialog.setBusy(busy, stage);
    this.#dateEditor?.setDisabled(busy);
    this.structureEditor.setDisabled(busy);
  }

  #showValidationError(error: unknown): void {
    const weight = this.#weightField?.input;
    const focus = !this.#nameField.input.value.trim()
      ? this.#nameField.input
      : weight && (!Number.isFinite(Number(weight.value)) || Number(weight.value) > 1)
        ? weight
        : this.#nameField.input;
    this.dialog.showError(
      safeEditorMessage(error, "任务内容不合法，请检查后重试。"),
      focus,
    );
  }

  #renderStructure(): void {
    const scope = findTask(this.#draft.root, this.#taskId);
    if (!scope) throw new TypeError("待编辑任务不存在。");
    if (this.#selectedTaskId !== null
      && !scope.children.some((task) => task.id === this.#selectedTaskId)) {
      this.#selectedTaskId = null;
    }
    this.structureEditor.render({
      task: scope,
      selectedTaskId: this.#selectedTaskId,
      disabled: this.#busy,
    });
    this.#options.bindStructure(this.structureEditor, (dragged, beforeGroupId) => {
      try {
        this.#draft = {
          ...this.#draft,
          root: reorderDependencyGroup(this.#draft.root, dragged, beforeGroupId),
        };
      } catch {
        this.#options.showMessage?.("依赖组只能在同一层级移动。", "error");
      }
      this.#renderStructure();
    });
  }

  #addParallel(selection: string | null): void {
    if (this.#busy || this.#disposed) return;
    const task = createTodoTask(this.#options.createId());
    const root = selection === null
      ? replaceTask(
        this.#draft.root,
        this.#taskId,
        insertParallelTask(findTask(this.#draft.root, this.#taskId)!, null, task),
      )
      : insertParallelTask(this.#draft.root, selection, task);
    this.#draft = { ...this.#draft, root };
    this.#selectedTaskId = task.id;
    this.#renderStructure();
  }

  #addSuccessor(selection: string): void {
    if (this.#busy || this.#disposed) return;
    const task = createTodoTask(this.#options.createId());
    this.#draft = {
      ...this.#draft,
      root: insertSuccessorTask(this.#draft.root, selection, task),
    };
    this.#selectedTaskId = task.id;
    this.#renderStructure();
  }

  async #deleteSelectedChild(selection: string): Promise<void> {
    if (this.#busy || this.#disposed) return;
    const task = findTask(this.#draft.root, selection);
    if (!task) return;
    const confirmed = await this.#options.confirm({
      title: "删除子任务？",
      message: `“${task.name}”及其全部子任务都会被删除。`,
      confirmLabel: "删除子任务",
      trigger: this.structureEditor.getTaskRow(selection)?.dragSource,
      canCancel: () => !this.#busy,
    });
    if (!confirmed || this.#disposed) return;
    this.#draft = {
      ...this.#draft,
      root: deleteTaskAndReconnect(this.#draft.root, selection),
    };
    this.#selectedTaskId = null;
    this.#renderStructure();
  }

  #openTask(taskId: string): void {
    if (this.#busy || this.#disposed) return;
    try {
      this.#options.openTask(this.#finalizeDraft(), taskId);
    } catch (error) {
      this.#showValidationError(error);
    }
  }
}
