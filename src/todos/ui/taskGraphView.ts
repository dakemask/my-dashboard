import {
  dependencyGroups,
  isTaskComplete,
  taskCompletionGate,
  taskProgress,
  type TodoTask,
} from "../domain";
import {
  TaskGraphConnections,
  type TaskGraphConnectionElements,
} from "./taskGraphConnections";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type TaskGraphKind = "instance" | "template";

export interface TaskGraphReorderIntent {
  readonly parentTaskId: string;
  readonly draggedGroupId: string;
  readonly beforeGroupId: string | null;
}

export interface TaskGraphReorderGroup {
  readonly parentTaskId: string;
  readonly groupId: string;
  readonly element: HTMLElement;
}

export interface TaskGraphViewCallbacks {
  readonly onOpenTask?: (taskId: string) => void;
  readonly onToggleTask?: (taskId: string, completed: boolean) => void;
  readonly onContextTask?: (taskId: string) => void;
  readonly onReorderGroup?: (intent: TaskGraphReorderIntent) => void;
  readonly onScrollLeftChange?: (scrollLeft: number) => void;
}

export interface TaskGraphFrameScheduler {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export interface TaskGraphViewConfig {
  readonly kind: TaskGraphKind;
  readonly ownerId: string;
  readonly showCheckboxes?: boolean;
  readonly showProgress?: boolean;
  readonly initialScrollLeft?: number;
  readonly callbacks?: TaskGraphViewCallbacks;
  readonly animationFrames?: TaskGraphFrameScheduler;
}

export interface TaskGraphRenderState {
  readonly root: TodoTask;
  readonly expanded: boolean;
  readonly disabled?: boolean;
}

interface TaskEntry extends TaskGraphConnectionElements {
  readonly taskId: string;
  readonly open: HTMLButtonElement;
  readonly checkbox: HTMLInputElement | null;
  readonly progress: HTMLProgressElement | null;
  readonly children: HTMLElement;
  readonly childGroups: HTMLElement;
}

interface GroupEntry {
  readonly parentTaskId: string;
  readonly groupId: string;
  readonly element: HTMLElement;
}

type PendingRedraw = "none" | "all" | Set<string>;

/**
 * Keyed presentation for both instance and recurring-template task graphs.
 * It projects one task root at a time and never owns or mutates a TodosPayload.
 */
export class TaskGraphView {
  readonly element: HTMLElement;
  readonly #document: Document;
  readonly #config: TaskGraphViewConfig;
  readonly #callbacks: TaskGraphViewCallbacks;
  readonly #frames: TaskGraphFrameScheduler;
  readonly #canvas: HTMLElement;
  readonly #content: HTMLElement;
  readonly #rootGroups: HTMLElement;
  readonly #svg: SVGSVGElement;
  readonly #connections: TaskGraphConnections;
  readonly #tasks = new Map<string, TaskEntry>();
  readonly #groups = new Map<string, GroupEntry>();
  readonly #groupParents = new Map<string, string>();
  readonly #onScroll: () => void;
  readonly #onResize: () => void;
  #expanded = false;
  #disabled = false;
  #disposed = false;
  #savedScrollLeft: number;
  #restoreScrollOnNextFrame = false;
  #frameHandle: number | null = null;
  #pendingRedraw: PendingRedraw = "none";
  #structureKey = "";
  #root: TodoTask | null = null;

  constructor(document: Document, config: TaskGraphViewConfig) {
    this.#document = document;
    this.#config = config;
    this.#callbacks = config.callbacks ?? {};
    this.#frames = config.animationFrames ?? browserFrameScheduler(document);
    this.#savedScrollLeft = normalizeScrollLeft(config.initialScrollLeft ?? 0);

    this.element = document.createElement("div");
    this.element.className = config.kind === "template"
      ? "todo-graph todo-rule-graph"
      : "todo-graph";
    this.element.dataset.taskGraphId = config.ownerId;
    if (config.kind === "template") this.element.dataset.ruleId = config.ownerId;
    else this.element.dataset.instanceId = config.ownerId;

    this.#canvas = document.createElement("div");
    this.#canvas.className = "todo-graph-canvas";
    this.#svg = document.createElementNS(SVG_NAMESPACE, "svg");
    this.#svg.classList.add("todo-graph-lines");
    this.#svg.setAttribute("aria-hidden", "true");
    this.#content = document.createElement("div");
    this.#content.className = "todo-graph-content";
    this.#rootGroups = document.createElement("div");
    this.#rootGroups.className = "todo-task-groups";
    this.#content.append(this.#rootGroups);
    this.#canvas.append(this.#svg, this.#content);
    this.element.append(this.#canvas);

    const markerId = `todo-arrow-${safeDomId(config.kind)}-${safeDomId(config.ownerId)}`;
    this.#connections = new TaskGraphConnections(document, this.#svg, markerId);
    this.#onScroll = () => {
      if (!this.#expanded || this.#disposed) return;
      this.#savedScrollLeft = normalizeScrollLeft(this.element.scrollLeft);
      this.#callbacks.onScrollLeftChange?.(this.#savedScrollLeft);
    };
    this.#onResize = () => this.redrawConnections();
    this.element.addEventListener("scroll", this.#onScroll);
    document.defaultView?.addEventListener("resize", this.#onResize);
  }

  get savedScrollLeft(): number {
    return this.#savedScrollLeft;
  }

  get expanded(): boolean {
    return this.#expanded;
  }

  render(state: TaskGraphRenderState): void {
    if (this.#disposed) return;
    this.#root = state.root;
    this.#disabled = state.disabled ?? false;
    this.element.setAttribute("aria-disabled", String(this.#disabled));
    const nextStructureKey = taskStructureKey(state.root);
    const structureChanged = nextStructureKey !== this.#structureKey;
    this.#structureKey = nextStructureKey;

    const seenTasks = new Set<string>();
    const seenGroups = new Set<string>();
    this.#groupParents.clear();
    this.#renderChildren(
      state.root,
      state.root.children,
      this.#rootGroups,
      seenTasks,
      seenGroups,
    );
    this.#sweepEntries(seenTasks, seenGroups);
    this.#connections.project(state.root);

    if (structureChanged) this.redrawConnections();
    this.setExpanded(state.expanded);
  }

  setExpanded(expanded: boolean): void {
    if (this.#disposed) return;
    const changed = expanded !== this.#expanded;
    if (!expanded && this.#expanded) {
      this.#savedScrollLeft = normalizeScrollLeft(this.element.scrollLeft);
    }
    this.#expanded = expanded;
    this.element.inert = !expanded;
    this.element.dataset.expanded = String(expanded);
    this.element.setAttribute("aria-hidden", String(!expanded));
    if (!expanded) {
      if (this.#frameHandle !== null) {
        this.#frames.cancel(this.#frameHandle);
        this.#frameHandle = null;
      }
      return;
    }
    if (changed) {
      this.#restoreScrollOnNextFrame = true;
      this.#mergePendingRedraw(undefined);
    }
    this.#scheduleFrame();
  }

  setScrollLeft(scrollLeft: number): void {
    this.#savedScrollLeft = normalizeScrollLeft(scrollLeft);
    if (this.#expanded) this.element.scrollLeft = this.#savedScrollLeft;
  }

  redrawConnections(taskIds?: Iterable<string>): void {
    if (this.#disposed) return;
    this.#mergePendingRedraw(taskIds);
    this.#scheduleFrame();
  }

  getReorderGroups(): readonly TaskGraphReorderGroup[] {
    return [...this.element.querySelectorAll<HTMLElement>(".todo-task-chain")]
      .flatMap((element) => {
        const parentTaskId = element.dataset.parentTaskId;
        const groupId = element.dataset.dragGroupId;
        return parentTaskId && groupId
          ? [{ parentTaskId, groupId, element }]
          : [];
      });
  }

  requestReorder(draggedGroupId: string, beforeGroupId: string | null): void {
    if (this.#disposed || this.#disabled || draggedGroupId === beforeGroupId) return;
    const parentTaskId = this.#groupParents.get(draggedGroupId);
    if (!parentTaskId) return;
    if (beforeGroupId !== null && this.#groupParents.get(beforeGroupId) !== parentTaskId) return;
    this.#callbacks.onReorderGroup?.({ parentTaskId, draggedGroupId, beforeGroupId });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#frameHandle !== null) this.#frames.cancel(this.#frameHandle);
    this.#frameHandle = null;
    this.element.removeEventListener("scroll", this.#onScroll);
    this.#document.defaultView?.removeEventListener("resize", this.#onResize);
    this.#connections.dispose();
    this.#tasks.clear();
    this.#groups.clear();
    this.#groupParents.clear();
    this.#root = null;
  }

  #renderChildren(
    parent: TodoTask,
    children: readonly TodoTask[],
    row: HTMLElement,
    seenTasks: Set<string>,
    seenGroups: Set<string>,
  ): void {
    const orderedGroups: HTMLElement[] = [];
    for (const tasks of dependencyGroups(children)) {
      const groupId = tasks[0]?.id;
      if (!groupId) continue;
      const key = groupKey(parent.id, groupId);
      let group = this.#groups.get(key);
      if (!group) {
        const element = this.#document.createElement("div");
        element.className = "todo-task-chain";
        group = { parentTaskId: parent.id, groupId, element };
        this.#groups.set(key, group);
      }
      seenGroups.add(key);
      this.#groupParents.set(groupId, parent.id);
      group.element.dataset.dragGroupId = groupId;
      group.element.dataset.parentTaskId = parent.id;
      const orderedSubtrees = tasks.map((task) => {
        const entry = this.#renderTask(task, groupId, seenTasks, seenGroups);
        return entry.subtree;
      });
      reconcileChildren(group.element, orderedSubtrees);
      orderedGroups.push(group.element);
    }
    reconcileChildren(row, orderedGroups);
  }

  #renderTask(
    task: TodoTask,
    groupId: string,
    seenTasks: Set<string>,
    seenGroups: Set<string>,
  ): TaskEntry {
    let entry = this.#tasks.get(task.id);
    if (!entry) {
      entry = this.#createTaskEntry(task.id);
      this.#tasks.set(task.id, entry);
    }
    seenTasks.add(task.id);
    const hasChildren = task.children.length > 0;
    entry.subtree.dataset.taskId = task.id;
    entry.subtree.classList.toggle("has-children", hasChildren);
    entry.node.dataset.taskId = task.id;
    entry.node.dataset.dragGroupId = groupId;
    if (!this.#disabled && this.#callbacks.onReorderGroup) {
      entry.node.dataset.draggable = "true";
    }
    else delete entry.node.dataset.draggable;
    entry.open.textContent = task.name;
    entry.open.disabled = this.#disabled || !this.#callbacks.onOpenTask;
    this.#syncCheckbox(entry.checkbox, task);
    this.#syncProgress(entry.progress, task);
    entry.children.hidden = !hasChildren;
    if (hasChildren) {
      this.#renderChildren(task, task.children, entry.childGroups, seenTasks, seenGroups);
    } else {
      reconcileChildren(entry.childGroups, []);
    }
    return entry;
  }

  #createTaskEntry(taskId: string): TaskEntry {
    const subtree = this.#document.createElement("div");
    subtree.className = "todo-task-subtree";
    const node = this.#document.createElement("div");
    node.className = this.#config.kind === "template"
      ? "todo-task-node todo-rule-task-node"
      : "todo-task-node";
    const body = this.#document.createElement("div");
    body.className = "todo-task-node-main";
    const checkbox = this.#showsCheckboxes()
      ? this.#document.createElement("input")
      : null;
    if (checkbox) {
      checkbox.type = "checkbox";
      checkbox.className = "todo-checkbox";
      checkbox.dataset.taskId = taskId;
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (this.#disposed || this.#disabled || checkbox.disabled) return;
        this.#callbacks.onToggleTask?.(taskId, checkbox.checked);
      });
      body.append(checkbox);
    }
    const open = this.#document.createElement("button");
    open.type = "button";
    open.className = "todo-task-open";
    open.addEventListener("click", () => {
      if (!this.#disposed && !this.#disabled) this.#callbacks.onOpenTask?.(taskId);
    });
    body.append(open);
    node.append(body);

    const progress = this.#showsProgress()
      ? this.#document.createElement("progress")
      : null;
    if (progress) {
      progress.className = "todo-progress";
      progress.dataset.taskId = taskId;
      progress.max = 1;
      node.append(progress);
    }
    node.addEventListener("contextmenu", (event) => {
      if (this.#disposed || this.#disabled || !this.#callbacks.onContextTask) return;
      if (event instanceof MouseEvent && event.button !== 2) return;
      event.preventDefault();
      this.#callbacks.onContextTask(taskId);
    });

    const children = this.#document.createElement("div");
    children.className = "todo-task-children";
    const childGroups = this.#document.createElement("div");
    childGroups.className = "todo-task-groups";
    children.append(childGroups);
    subtree.append(node, children);
    return {
      taskId,
      subtree,
      node,
      open,
      checkbox,
      progress,
      children,
      childGroups,
    };
  }

  #syncCheckbox(checkbox: HTMLInputElement | null, task: TodoTask): void {
    if (!checkbox) return;
    const completed = isTaskComplete(task);
    const gate = this.#root === null
      ? taskCompletionGate(task, task.id)
      : taskCompletionGate(this.#root, task.id);
    checkbox.checked = completed;
    const unavailable = this.#disabled || !this.#callbacks.onToggleTask;
    checkbox.disabled = unavailable || task.children.length > 0 || !gate.allowed;
    checkbox.title = task.children.length > 0
      ? "完成状态由所有子任务决定"
      : !gate.allowed && gate.reason === "predecessor-incomplete"
        ? "请先完成前置任务"
        : unavailable ? "当前暂不可操作" : "切换完成状态";
    checkbox.setAttribute("aria-label", `${task.name}：${checkbox.title}`);
  }

  #syncProgress(progress: HTMLProgressElement | null, task: TodoTask): void {
    if (!progress) return;
    const value = taskProgress(task);
    progress.value = value;
    progress.setAttribute("aria-label", `${task.name}进度`);
  }

  #sweepEntries(seenTasks: ReadonlySet<string>, seenGroups: ReadonlySet<string>): void {
    for (const [taskId, entry] of this.#tasks) {
      if (seenTasks.has(taskId)) continue;
      entry.subtree.remove();
      this.#tasks.delete(taskId);
    }
    for (const [key, group] of this.#groups) {
      if (seenGroups.has(key)) continue;
      group.element.remove();
      this.#groups.delete(key);
    }
  }

  #showsCheckboxes(): boolean {
    return this.#config.showCheckboxes ?? this.#config.kind === "instance";
  }

  #showsProgress(): boolean {
    return this.#config.showProgress ?? this.#config.kind === "instance";
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
    if (!this.#expanded || this.#frameHandle !== null || this.#disposed) return;
    if (!this.#restoreScrollOnNextFrame && this.#pendingRedraw === "none") return;
    this.#frameHandle = this.#frames.request(() => {
      this.#frameHandle = null;
      if (this.#disposed || !this.#expanded) return;
      if (this.#restoreScrollOnNextFrame) {
        this.element.scrollLeft = this.#savedScrollLeft;
        this.#restoreScrollOnNextFrame = false;
      }
      const pending = this.#pendingRedraw;
      this.#pendingRedraw = "none";
      if (pending === "none") return;
      this.#connections.draw(
        this.element,
        this.#canvas,
        (taskId) => this.#tasks.get(taskId) ?? null,
        pending === "all" ? undefined : pending,
      );
    });
  }
}

function groupKey(parentTaskId: string, groupId: string): string {
  return JSON.stringify([parentTaskId, groupId]);
}

function taskStructureKey(root: TodoTask): string {
  const visit = (task: TodoTask): unknown => [
    task.id,
    task.name,
    task.predecessorId,
    task.children.map(visit),
  ];
  return JSON.stringify(visit(root));
}

function safeDomId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/gu, "-");
  return normalized || "graph";
}

function normalizeScrollLeft(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
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

function browserFrameScheduler(document: Document): TaskGraphFrameScheduler {
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
