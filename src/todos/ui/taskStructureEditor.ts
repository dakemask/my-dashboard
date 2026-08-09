import {
  AddOne,
  ArrowRight,
  Delete,
  Drag,
  Right,
} from "@icon-park/svg";
import { createIconOnlyButton } from "../../shared";
import { dependencyGroups, type TodoTask } from "../domain";
import { createTodoIcon, type TodoIconRenderer } from "./icons";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type TaskStructureKind = "instance" | "template";

export interface TaskStructureEditorCallbacks {
  readonly onOpenTask?: (taskId: string) => void;
  readonly onSelectTask?: (taskId: string) => void;
  readonly onAddParallel?: (selectedTaskId: string | null) => void;
  readonly onAddSuccessor?: (selectedTaskId: string) => void;
  readonly onDeleteTask?: (selectedTaskId: string) => void;
}

export interface TaskStructureFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface TaskStructureEditorConfig {
  readonly kind: TaskStructureKind;
  readonly callbacks?: TaskStructureEditorCallbacks;
  readonly animationFrames?: TaskStructureFrameScheduler;
}

export interface TaskStructureRenderState {
  /** The currently edited task. Only its direct children are projected. */
  readonly task: TodoTask;
  readonly selectedTaskId: string | null;
  readonly disabled?: boolean;
}

export interface TaskStructureTaskRow {
  readonly taskId: string;
  readonly groupId: string;
  /** A direct child of `reorderContainer`; move this element during reorder previews. */
  readonly element: HTMLElement;
  /** Bind PointerReorder here so the separate open action stays independently clickable. */
  readonly dragSource: HTMLElement;
}

export interface TaskStructureReorderGroup {
  readonly parentTaskId: string;
  readonly groupId: string;
  readonly taskIds: readonly string[];
  /** Consecutive direct children of `reorderContainer`. */
  readonly elements: readonly HTMLElement[];
}

interface TaskRowEntry {
  readonly taskId: string;
  readonly item: HTMLElement;
  readonly select: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly open: HTMLButtonElement;
  groupId: string;
}

interface DependencyConnection {
  readonly predecessorId: string;
  readonly successorId: string;
}

type PendingRedraw = "none" | "all" | Set<string>;

/**
 * Keyed direct-child editor shared by instance and recurring-template dialogs.
 * It owns presentation state only: payload mutation and task-tree commands stay outside.
 */
export class TaskStructureEditor {
  readonly element: HTMLElement;
  readonly scrollElement: HTMLElement;
  readonly kind: TaskStructureKind;
  /** All task items are consecutive direct children of this stable container. */
  readonly reorderContainer: HTMLElement;

  readonly #document: Document;
  readonly #callbacks: TaskStructureEditorCallbacks;
  readonly #frames: TaskStructureFrameScheduler;
  readonly #empty: HTMLElement;
  readonly #svg: SVGSVGElement;
  readonly #defs: SVGDefsElement;
  readonly #parallelButton: HTMLButtonElement;
  readonly #successorButton: HTMLButtonElement;
  readonly #deleteButton: HTMLButtonElement;
  readonly #rows = new Map<string, TaskRowEntry>();
  readonly #paths = new Map<string, SVGPathElement>();
  readonly #onResize: () => void;
  #parentTaskId: string | null = null;
  #children: readonly TodoTask[] = [];
  #connections: readonly DependencyConnection[] = [];
  #rowOrder: readonly string[] = [];
  #selectedTaskId: string | null = null;
  #disabled = false;
  #disposed = false;
  #frameHandle: number | null = null;
  #pendingRedraw: PendingRedraw = "none";

  constructor(document: Document, config: TaskStructureEditorConfig) {
    this.#document = document;
    this.kind = config.kind;
    this.#callbacks = config.callbacks ?? {};
    this.#frames = config.animationFrames ?? browserFrameScheduler(document);

    this.element = document.createElement("section");
    this.element.className = "todo-editor-tasks";
    this.element.dataset.taskStructureKind = config.kind;

    const heading = document.createElement("div");
    heading.className = "todo-editor-task-heading";
    const title = document.createElement("h3");
    title.textContent = config.kind === "template" ? "模板子任务" : "子任务结构";
    const hint = document.createElement("p");
    hint.textContent = "仅显示当前任务的直接子任务";
    heading.append(title, hint);

    this.scrollElement = document.createElement("div");
    this.scrollElement.className = "todo-editor-task-list";
    this.scrollElement.tabIndex = 0;
    this.scrollElement.setAttribute("aria-label", title.textContent);

    this.reorderContainer = document.createElement("div");
    this.reorderContainer.className = "todo-editor-task-groups";
    this.reorderContainer.setAttribute("role", "list");
    this.#svg = document.createElementNS(SVG_NAMESPACE, "svg");
    this.#svg.classList.add("todo-editor-dependency-lines");
    this.#svg.setAttribute("aria-hidden", "true");
    const markerId = nextMarkerId(config.kind);
    this.#defs = createArrowMarker(document, markerId);
    this.#svg.append(this.#defs);
    this.#empty = document.createElement("p");
    this.#empty.className = "todos-empty todo-editor-task-empty";
    this.#empty.textContent = config.kind === "template"
      ? "暂无模板子任务。"
      : "暂无子任务。";
    this.reorderContainer.append(this.#svg, this.#empty);
    this.scrollElement.append(this.reorderContainer);

    const toolbar = document.createElement("div");
    toolbar.className = "todo-editor-toolbar";
    this.#parallelButton = textButton(document, "新增并列", "todos-button secondary", AddOne);
    this.#successorButton = textButton(document, "新增递进", "todos-button secondary", ArrowRight);
    this.#deleteButton = textButton(document, "删除选中", "todos-button danger", Delete);
    toolbar.append(this.#parallelButton, this.#successorButton, this.#deleteButton);
    this.element.append(heading, this.scrollElement, toolbar);

    this.#parallelButton.addEventListener("click", () => {
      if (this.#disposed || this.#disabled) return;
      this.#callbacks.onAddParallel?.(this.#selectedTaskId);
    });
    this.#successorButton.addEventListener("click", () => {
      if (this.#disposed || this.#disabled || this.#selectedTaskId === null) return;
      this.#callbacks.onAddSuccessor?.(this.#selectedTaskId);
    });
    this.#deleteButton.addEventListener("click", () => {
      if (this.#disposed || this.#disabled || this.#selectedTaskId === null) return;
      this.#callbacks.onDeleteTask?.(this.#selectedTaskId);
    });

    this.#onResize = () => this.redrawConnections();
    document.defaultView?.addEventListener("resize", this.#onResize);
    this.#syncCommandState();
  }

  get selectedTaskId(): string | null {
    return this.#selectedTaskId;
  }

  get disabled(): boolean {
    return this.#disabled;
  }

  render(state: TaskStructureRenderState): void {
    if (this.#disposed) return;
    this.#parentTaskId = state.task.id;
    this.#children = state.task.children;
    this.#disabled = state.disabled ?? false;
    this.element.dataset.parentTaskId = state.task.id;
    this.element.setAttribute("aria-disabled", String(this.#disabled));

    const directIds = new Set(state.task.children.map((task) => task.id));
    this.#selectedTaskId = state.selectedTaskId !== null && directIds.has(state.selectedTaskId)
      ? state.selectedTaskId
      : null;

    const seen = new Set<string>();
    const orderedRows: HTMLElement[] = [];
    const orderedIds: string[] = [];
    for (const group of dependencyGroups(state.task.children)) {
      const groupId = group[0]?.id;
      if (!groupId) continue;
      for (const task of group) {
        const entry = this.#renderRow(task, groupId);
        seen.add(task.id);
        orderedIds.push(task.id);
        orderedRows.push(entry.item);
      }
    }
    this.#rowOrder = orderedIds;
    this.#sweepRows(seen);
    this.#empty.hidden = orderedRows.length > 0;
    reconcileChildren(
      this.reorderContainer,
      [this.#svg, ...(this.#empty.hidden ? [] : [this.#empty]), ...orderedRows],
    );
    this.#syncConnections(state.task.children);
    this.#syncSelection();
    this.#syncCommandState();
    this.redrawConnections();
  }

  setSelectedTaskId(taskId: string | null, notify = false): void {
    if (this.#disposed) return;
    const next = taskId !== null && this.#rows.has(taskId) ? taskId : null;
    if (next === this.#selectedTaskId) return;
    this.#selectedTaskId = next;
    this.#syncSelection();
    this.#syncCommandState();
    if (notify && next !== null) this.#callbacks.onSelectTask?.(next);
  }

  setDisabled(disabled: boolean): void {
    if (this.#disposed || disabled === this.#disabled) return;
    this.#disabled = disabled;
    this.element.setAttribute("aria-disabled", String(disabled));
    for (const entry of this.#rows.values()) {
      entry.select.disabled = disabled;
      entry.open.disabled = disabled || !this.#callbacks.onOpenTask;
    }
    this.#syncCommandState();
  }

  getTaskRows(): readonly TaskStructureTaskRow[] {
    return this.#rowOrder.flatMap((taskId) => {
      const entry = this.#rows.get(taskId);
      return entry
        ? [{ taskId, groupId: entry.groupId, element: entry.item, dragSource: entry.select }]
        : [];
    });
  }

  getTaskRow(taskId: string): TaskStructureTaskRow | null {
    const entry = this.#rows.get(taskId);
    return entry
      ? { taskId, groupId: entry.groupId, element: entry.item, dragSource: entry.select }
      : null;
  }

  getReorderGroups(): readonly TaskStructureReorderGroup[] {
    if (this.#parentTaskId === null) return [];
    return dependencyGroups(this.#children).flatMap((group) => {
      const groupId = group[0]?.id;
      if (!groupId) return [];
      const entries = group
        .map((task) => this.#rows.get(task.id) ?? null)
        .filter((entry): entry is TaskRowEntry => entry !== null);
      return entries.length === 0
        ? []
        : [{
          parentTaskId: this.#parentTaskId!,
          groupId,
          taskIds: entries.map((entry) => entry.taskId),
          elements: entries.map((entry) => entry.item),
        }];
    });
  }

  redrawConnections(taskIds?: Iterable<string>): void {
    if (this.#disposed) return;
    this.#mergePendingRedraw(taskIds);
    this.#scheduleFrame();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disabled = true;
    this.element.setAttribute("aria-disabled", "true");
    for (const entry of this.#rows.values()) {
      entry.select.disabled = true;
      entry.open.disabled = true;
    }
    this.#syncCommandState();
    if (this.#frameHandle !== null) this.#frames.cancel(this.#frameHandle);
    this.#frameHandle = null;
    this.#document.defaultView?.removeEventListener("resize", this.#onResize);
    this.#rows.clear();
    this.#paths.clear();
    this.#children = [];
    this.#connections = [];
    this.#rowOrder = [];
  }

  #renderRow(task: TodoTask, groupId: string): TaskRowEntry {
    let entry = this.#rows.get(task.id);
    if (!entry) {
      const item = this.#document.createElement("div");
      item.className = "todo-editor-task-item";
      item.setAttribute("role", "listitem");
      const select = this.#document.createElement("button");
      select.type = "button";
      select.className = "todo-editor-task-row";
      select.append(createTodoIcon(this.#document, Drag, 18));
      const name = this.#document.createElement("span");
      select.append(name);
      const open = createIconOnlyButton(this.#document, Right, "打开子任务", {
        classNames: "todo-editor-task-open compact",
        iconSize: 18,
      });
      item.append(select, open);
      entry = { taskId: task.id, item, select, name, open, groupId };
      this.#rows.set(task.id, entry);
      select.addEventListener("click", () => {
        if (this.#disposed || this.#disabled) return;
        this.setSelectedTaskId(task.id);
        this.#callbacks.onSelectTask?.(task.id);
      });
      open.addEventListener("click", () => {
        if (!this.#disposed && !this.#disabled) this.#callbacks.onOpenTask?.(task.id);
      });
    }

    entry.groupId = groupId;
    entry.item.dataset.taskId = task.id;
    entry.item.dataset.dragGroupId = groupId;
    entry.select.dataset.taskId = task.id;
    entry.select.dataset.dragGroupId = groupId;
    entry.name.textContent = task.name;
    entry.select.setAttribute("aria-label", `选择子任务：${task.name}`);
    entry.open.title = `打开子任务：${task.name}`;
    entry.open.setAttribute("aria-label", entry.open.title);
    entry.select.disabled = this.#disabled;
    entry.open.disabled = this.#disabled || !this.#callbacks.onOpenTask;
    return entry;
  }

  #sweepRows(seen: ReadonlySet<string>): void {
    for (const [taskId, entry] of this.#rows) {
      if (seen.has(taskId)) continue;
      entry.item.remove();
      this.#rows.delete(taskId);
    }
  }

  #syncSelection(): void {
    for (const entry of this.#rows.values()) {
      const selected = entry.taskId === this.#selectedTaskId;
      entry.item.dataset.selected = String(selected);
      entry.select.dataset.selected = String(selected);
      entry.select.setAttribute("aria-pressed", String(selected));
    }
  }

  #syncCommandState(): void {
    const hasSelection = this.#selectedTaskId !== null;
    this.#parallelButton.disabled = this.#disabled || !this.#callbacks.onAddParallel;
    this.#successorButton.disabled = this.#disabled
      || !hasSelection
      || !this.#callbacks.onAddSuccessor;
    this.#deleteButton.disabled = this.#disabled
      || !hasSelection
      || !this.#callbacks.onDeleteTask;
  }

  #syncConnections(children: readonly TodoTask[]): void {
    this.#connections = children.flatMap((task) => task.predecessorId === null
      ? []
      : [{ predecessorId: task.predecessorId, successorId: task.id }]);
    const nextKeys = new Set(this.#connections.map(connectionKey));
    for (const [key, path] of this.#paths) {
      if (nextKeys.has(key)) continue;
      path.remove();
      this.#paths.delete(key);
    }
    const ordered: Node[] = [this.#defs];
    for (const connection of this.#connections) {
      const key = connectionKey(connection);
      let path = this.#paths.get(key);
      if (!path) {
        path = this.#document.createElementNS(SVG_NAMESPACE, "path");
        path.dataset.connectionKey = key;
        path.dataset.predecessorId = connection.predecessorId;
        path.dataset.successorId = connection.successorId;
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#18221b");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("marker-end", `url(#${this.#defs.querySelector("marker")!.id})`);
        this.#paths.set(key, path);
      }
      ordered.push(path);
    }
    reconcileChildren(this.#svg, ordered);
  }

  #mergePendingRedraw(taskIds?: Iterable<string>): void {
    if (taskIds === undefined) {
      this.#pendingRedraw = "all";
      return;
    }
    if (this.#pendingRedraw === "all") return;
    if (this.#pendingRedraw === "none") this.#pendingRedraw = new Set<string>();
    for (const taskId of taskIds) this.#pendingRedraw.add(taskId);
  }

  #scheduleFrame(): void {
    if (this.#frameHandle !== null || this.#disposed || this.#pendingRedraw === "none") return;
    this.#frameHandle = this.#frames.request(() => {
      this.#frameHandle = null;
      if (this.#disposed) return;
      const pending = this.#pendingRedraw;
      this.#pendingRedraw = "none";
      if (pending !== "none") this.#drawConnections(pending === "all" ? undefined : pending);
    });
  }

  #drawConnections(affectedTaskIds?: ReadonlySet<string>): void {
    const width = Math.max(this.reorderContainer.scrollWidth, this.scrollElement.clientWidth);
    const height = Math.max(this.reorderContainer.scrollHeight, this.scrollElement.clientHeight);
    this.#svg.setAttribute("width", String(width));
    this.#svg.setAttribute("height", String(height));
    this.#svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const base = this.reorderContainer.getBoundingClientRect();

    for (const connection of this.#connections) {
      if (affectedTaskIds
        && !affectedTaskIds.has(connection.predecessorId)
        && !affectedTaskIds.has(connection.successorId)) continue;
      const path = this.#paths.get(connectionKey(connection));
      const predecessor = this.#rows.get(connection.predecessorId)?.item;
      const successor = this.#rows.get(connection.successorId)?.item;
      if (!path || !predecessor || !successor) continue;
      const from = predecessor.getBoundingClientRect();
      const to = successor.getBoundingClientRect();
      const startX = from.right - base.left;
      const startY = from.top - base.top + from.height * 0.68;
      const endX = to.right - base.left + 2;
      const endY = to.top - base.top + to.height * 0.32;
      const controlReach = Math.max(8, Math.min(19, width - 8 - Math.max(startX, endX)));
      const controlDrop = 9;
      path.setAttribute(
        "d",
        `M${startX},${startY} C${startX + controlReach},${startY + controlDrop} ${endX + controlReach},${endY - controlDrop} ${endX},${endY}`,
      );
    }
  }
}

function textButton(
  document: Document,
  label: string,
  className: string,
  icon: TodoIconRenderer,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.append(createTodoIcon(document, icon, 18), document.createTextNode(label));
  return button;
}

function connectionKey(connection: DependencyConnection): string {
  return `${connection.predecessorId}->${connection.successorId}`;
}

function createArrowMarker(document: Document, markerId: string): SVGDefsElement {
  const defs = document.createElementNS(SVG_NAMESPACE, "defs");
  const marker = document.createElementNS(SVG_NAMESPACE, "marker");
  marker.setAttribute("id", markerId);
  marker.setAttribute("markerWidth", "5.5");
  marker.setAttribute("markerHeight", "5.5");
  marker.setAttribute("refX", "5.1");
  marker.setAttribute("refY", "2.75");
  marker.setAttribute("orient", "auto");
  const arrow = document.createElementNS(SVG_NAMESPACE, "path");
  arrow.setAttribute("d", "M0,0 L5.5,2.75 L0,5.5 Z");
  arrow.setAttribute("fill", "#18221b");
  marker.append(arrow);
  defs.append(marker);
  return defs;
}

let markerSequence = 0;

function nextMarkerId(kind: TaskStructureKind): string {
  markerSequence += 1;
  return `todo-editor-arrow-${kind}-${markerSequence}`;
}

function reconcileChildren(parent: ParentNode, ordered: readonly Node[]): void {
  const desired = new Set(ordered);
  for (const child of [...parent.childNodes]) {
    if (!desired.has(child)) child.remove();
  }
  ordered.forEach((child, index) => {
    if (parent.childNodes[index] !== child) parent.insertBefore(child, parent.childNodes[index] ?? null);
  });
}

function browserFrameScheduler(document: Document): TaskStructureFrameScheduler {
  const window = document.defaultView;
  if (window && typeof window.requestAnimationFrame === "function") {
    return {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
    };
  }
  return {
    request: (callback) => globalThis.setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancel: (handle) => globalThis.clearTimeout(handle),
  };
}
