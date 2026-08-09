import { Delete, Save } from "@icon-park/svg";
import {
  createTodoTask,
  createTodosEvent,
  deleteTaskAndReconnect,
  findTask,
  initializeRulePeriod,
  insertParallelTask,
  insertSuccessorTask,
  reorderDependencyGroup,
  replaceTask,
  setTaskWeight,
  validateTodosPayload,
  type TodoCadence,
  type TodoRecurrenceRule,
  type TodosEvent,
  type TodosPayload,
} from "../domain";
import type { TodoConfirmationOptions } from "./confirmDialog";
import {
  createEditorField,
  createWeightEditorField,
  safeEditorMessage,
  TodoEditorDialog,
  type TodoEditorField,
} from "./editorDialog";
import { textButton } from "./shell";
import { TaskStructureEditor } from "./taskStructureEditor";

export interface TodoRecurrenceEditorOptions {
  readonly mount: HTMLElement;
  readonly baseline: TodoRecurrenceRule;
  readonly draft?: TodoRecurrenceRule;
  readonly taskId: string;
  readonly isNew: boolean;
  readonly trigger?: HTMLElement | null;
  readonly createId: () => string;
  readonly getPayload: () => TodosPayload;
  readonly commit: (next: TodosPayload) => Promise<boolean>;
  readonly confirm: (options: TodoConfirmationOptions) => Promise<boolean>;
  readonly requestClose: () => void;
  readonly openTask: (draft: TodoRecurrenceRule, taskId: string) => void;
  readonly bindStructure: (
    editor: TaskStructureEditor,
    reorder: (draggedGroupId: string, beforeGroupId: string | null) => void,
  ) => void;
  readonly showMessage?: (message: string, tone: "normal" | "success" | "error") => void;
  readonly now?: () => Date;
}

interface CadenceInputs {
  readonly weekly: HTMLInputElement;
  readonly monthly: HTMLInputElement;
}

/** Complete recurring-template draft workflow, including cadence generation on commit. */
export class TodoRecurrenceEditor {
  readonly dialog: TodoEditorDialog;
  readonly structureEditor: TaskStructureEditor;
  readonly trigger: HTMLElement | null;

  readonly #options: TodoRecurrenceEditorOptions;
  readonly #baseline: TodoRecurrenceRule;
  readonly #taskId: string;
  readonly #isNew: boolean;
  readonly #nameField: TodoEditorField;
  readonly #weightField: TodoEditorField | null;
  readonly #cadenceInputs: CadenceInputs | null;
  readonly #now: () => Date;
  #draft: TodoRecurrenceRule;
  #selectedTaskId: string | null = null;
  #busy = false;
  #disposed = false;

  constructor(document: Document, options: TodoRecurrenceEditorOptions) {
    this.#options = options;
    this.#baseline = structuredClone(options.baseline) as TodoRecurrenceRule;
    this.#draft = structuredClone(options.draft ?? options.baseline) as TodoRecurrenceRule;
    this.#taskId = options.taskId;
    this.#isNew = options.isNew;
    this.#now = options.now ?? (() => new Date());
    const editedTask = findTask(this.#draft.template, this.#taskId);
    if (!editedTask) throw new TypeError("待编辑模板任务不存在。");
    const editingRoot = this.#taskId === this.#draft.template.id;

    this.dialog = new TodoEditorDialog(document, {
      mount: options.mount,
      title: options.isNew ? "新建周期模板" : "编辑周期模板",
      trigger: options.trigger,
      classNames: "todo-task-editor-dialog",
      onCancel: options.requestClose,
      canCancel: () => !this.#busy,
    });
    this.trigger = this.dialog.trigger;
    this.#nameField = createEditorField(document, editingRoot ? "模板名称" : "任务名称");
    this.#nameField.input.value = editedTask.name;
    this.dialog.body.append(this.#nameField.label);

    if (editingRoot) {
      this.#weightField = null;
      const cadence = createCadenceField(document, this.#draft.id, this.#draft.cadence);
      this.#cadenceInputs = cadence.inputs;
      this.dialog.body.append(cadence.fieldset);
    } else {
      this.#cadenceInputs = null;
      this.#weightField = createWeightEditorField(document, editedTask.weight);
      this.dialog.body.append(this.#weightField.label);
    }

    this.structureEditor = new TaskStructureEditor(document, {
      kind: "template",
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
    const save = textButton(document, "保存模板", "todos-button primary", Save);
    const remove = !options.isNew
      ? textButton(
        document,
        editingRoot ? "删除模板" : "删除模板任务",
        "todos-button danger",
        Delete,
      )
      : null;
    this.dialog.actions.append(cancel, save);
    if (remove) this.dialog.actions.append(remove);
    cancel.addEventListener("click", options.requestClose);
    save.addEventListener("click", () => void this.save());
    remove?.addEventListener("click", () => void this.delete(remove));
  }

  open(): void {
    this.dialog.open(this.#nameField.input);
  }

  buildNext(payload: TodosPayload): TodosPayload {
    let rule = this.#finalizeDraft();
    let generated = null;
    if (this.#isNew || rule.cadence !== this.#baseline.cadence) {
      const initialized = initializeRulePeriod(rule, this.#now(), this.#options.createId);
      rule = initialized.rule;
      generated = initialized.instance;
    }
    return validateTodosPayload({
      instances: generated ? [...payload.instances, generated] : payload.instances,
      rules: this.#isNew
        ? [...payload.rules, rule]
        : payload.rules.map((candidate) => candidate.id === rule.id ? rule : candidate),
    });
  }

  settle(payload: TodosPayload): TodosEvent | null {
    const next = this.buildNext(payload);
    const event = createTodosEvent(payload, next);
    return event.instances.length || event.rules.length ? event : null;
  }

  async save(): Promise<boolean> {
    if (this.#busy || this.#disposed) return false;
    let next: TodosPayload;
    try {
      next = this.buildNext(this.#options.getPayload());
    } catch (error) {
      this.#showValidationError(error);
      return false;
    }
    return this.#commit(next, "正在保存模板…");
  }

  async delete(trigger?: HTMLElement): Promise<boolean> {
    if (this.#busy || this.#disposed || this.#isNew) return false;
    const deletingRoot = this.#taskId === this.#draft.template.id;
    const confirmed = await this.#options.confirm({
      title: deletingRoot ? "删除周期模板？" : "删除模板任务？",
      message: deletingRoot
        ? "模板将停止生成新待办，已经生成的任务会保留。"
        : "当前任务及其全部子任务都会从模板中删除。",
      confirmLabel: deletingRoot ? "删除模板" : "删除模板任务",
      trigger,
      canCancel: () => !this.#busy,
    });
    if (!confirmed || this.#disposed) return false;
    return this.#commit(this.#buildDeletion(this.#options.getPayload()), "正在删除…");
  }

  setDisabled(disabled: boolean): void {
    if (this.#disposed) return;
    this.#nameField.input.disabled = disabled;
    if (this.#weightField) {
      for (const input of this.#weightField.label.querySelectorAll("input")) input.disabled = disabled;
    }
    if (this.#cadenceInputs) {
      this.#cadenceInputs.weekly.disabled = disabled;
      this.#cadenceInputs.monthly.disabled = disabled;
    }
    this.structureEditor.setDisabled(disabled);
  }

  dispose(restoreFocus = true): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#busy = false;
    this.structureEditor.dispose();
    this.dialog.dispose(restoreFocus);
  }

  #finalizeDraft(): TodoRecurrenceRule {
    const name = this.#nameField.input.value.trim();
    if (!name) throw new TypeError("模板或任务名称不能为空。");
    const current = findTask(this.#draft.template, this.#taskId);
    if (!current) throw new TypeError("待编辑模板任务不存在。");
    let template = replaceTask(this.#draft.template, this.#taskId, { ...current, name });
    if (this.#weightField) {
      template = setTaskWeight(template, this.#taskId, Number(this.#weightField.input.value));
    }
    return {
      ...this.#draft,
      cadence: this.#selectedCadence(),
      template,
    };
  }

  #selectedCadence(): TodoCadence {
    if (!this.#cadenceInputs) return this.#draft.cadence;
    return this.#cadenceInputs.weekly.checked ? "weekly" : "monthly";
  }

  #buildDeletion(payload: TodosPayload): TodosPayload {
    if (this.#taskId === this.#draft.template.id) {
      return validateTodosPayload({
        ...payload,
        rules: payload.rules.filter((rule) => rule.id !== this.#baseline.id),
      });
    }
    const template = deleteTaskAndReconnect(this.#draft.template, this.#taskId);
    return validateTodosPayload({
      ...payload,
      rules: payload.rules.map((rule) => rule.id === this.#baseline.id
        ? { ...this.#draft, template }
        : rule),
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
    this.structureEditor.setDisabled(busy);
  }

  #showValidationError(error: unknown): void {
    const weight = this.#weightField?.input;
    const focus = !this.#nameField.input.value.trim()
      ? this.#nameField.input
      : weight && (!Number.isFinite(Number(weight.value)) || Number(weight.value) > 1)
        ? weight
        : this.#nameField.input;
    this.dialog.showError(safeEditorMessage(error, "周期模板内容不合法。"), focus);
  }

  #renderStructure(): void {
    const scope = findTask(this.#draft.template, this.#taskId);
    if (!scope) throw new TypeError("待编辑模板任务不存在。");
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
          template: reorderDependencyGroup(this.#draft.template, dragged, beforeGroupId),
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
    const template = selection === null
      ? replaceTask(
        this.#draft.template,
        this.#taskId,
        insertParallelTask(findTask(this.#draft.template, this.#taskId)!, null, task),
      )
      : insertParallelTask(this.#draft.template, selection, task);
    this.#draft = { ...this.#draft, template };
    this.#selectedTaskId = task.id;
    this.#renderStructure();
  }

  #addSuccessor(selection: string): void {
    if (this.#busy || this.#disposed) return;
    const task = createTodoTask(this.#options.createId());
    this.#draft = {
      ...this.#draft,
      template: insertSuccessorTask(this.#draft.template, selection, task),
    };
    this.#selectedTaskId = task.id;
    this.#renderStructure();
  }

  async #deleteSelectedChild(selection: string): Promise<void> {
    if (this.#busy || this.#disposed) return;
    const task = findTask(this.#draft.template, selection);
    if (!task) return;
    const confirmed = await this.#options.confirm({
      title: "删除模板子任务？",
      message: `“${task.name}”及其全部子任务都会从模板中删除。`,
      confirmLabel: "删除子任务",
      trigger: this.structureEditor.getTaskRow(selection)?.dragSource,
      canCancel: () => !this.#busy,
    });
    if (!confirmed || this.#disposed) return;
    this.#draft = {
      ...this.#draft,
      template: deleteTaskAndReconnect(this.#draft.template, selection),
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

function createCadenceField(
  document: Document,
  ruleId: string,
  cadence: TodoCadence,
): { fieldset: HTMLFieldSetElement; inputs: CadenceInputs } {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "todo-cadence";
  const legend = document.createElement("legend");
  legend.textContent = "生成周期";
  const weekly = radio(document, "每周任务", "weekly", cadence === "weekly");
  const monthly = radio(document, "每月任务", "monthly", cadence === "monthly");
  weekly.input.name = monthly.input.name = `cadence-${ruleId}`;
  fieldset.append(legend, weekly.label, monthly.label);
  return { fieldset, inputs: { weekly: weekly.input, monthly: monthly.input } };
}

function radio(
  document: Document,
  labelText: string,
  value: string,
  checked: boolean,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.value = value;
  input.checked = checked;
  label.append(input, document.createTextNode(labelText));
  return { label, input };
}
