import type { TodoTask } from "../domain";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

type Point = Readonly<{ x: number; y: number }>;

type TaskGraphConnection =
  | {
    readonly key: string;
    readonly kind: "parent";
    readonly parentId: string;
    readonly childIds: readonly string[];
    readonly taskIds: ReadonlySet<string>;
  }
  | {
    readonly key: string;
    readonly kind: "dependency";
    readonly predecessorId: string;
    readonly successorId: string;
    readonly taskIds: ReadonlySet<string>;
  };

export interface TaskGraphConnectionElements {
  readonly node: HTMLElement;
  readonly subtree: HTMLElement;
}

export class TaskGraphConnections {
  readonly #document: Document;
  readonly #svg: SVGSVGElement;
  readonly #markerId: string;
  readonly #defs: SVGDefsElement;
  readonly #paths = new Map<string, SVGPathElement>();
  #connections: readonly TaskGraphConnection[] = [];

  constructor(document: Document, svg: SVGSVGElement, markerId: string) {
    this.#document = document;
    this.#svg = svg;
    this.#markerId = markerId;
    this.#defs = this.#createMarker();
    this.#svg.append(this.#defs);
  }

  project(root: TodoTask): void {
    this.#connections = collectConnections(root);
    const nextKeys = new Set(this.#connections.map((connection) => connection.key));
    for (const [key, path] of this.#paths) {
      if (nextKeys.has(key)) continue;
      path.remove();
      this.#paths.delete(key);
    }

    const ordered: Node[] = [this.#defs];
    for (const connection of this.#connections) {
      let path = this.#paths.get(connection.key);
      if (!path) {
        path = this.#document.createElementNS(SVG_NAMESPACE, "path");
        path.dataset.connectionKey = connection.key;
        path.dataset.connectionKind = connection.kind;
        path.setAttribute("fill", "none");
        path.setAttribute("stroke-width", "2");
        path.setAttribute("stroke-linejoin", "round");
        if (connection.kind === "dependency") {
          path.setAttribute("stroke", "#168a53");
          path.setAttribute("marker-end", `url(#${this.#markerId})`);
        } else {
          path.setAttribute("stroke", "#9aa8a0");
        }
        this.#paths.set(connection.key, path);
      }
      ordered.push(path);
    }
    reconcileChildren(this.#svg, ordered);
  }

  draw(
    graph: HTMLElement,
    canvas: HTMLElement,
    resolve: (taskId: string) => TaskGraphConnectionElements | null,
    affectedTaskIds?: ReadonlySet<string>,
  ): void {
    const width = Math.max(canvas.scrollWidth, graph.clientWidth);
    const height = Math.max(canvas.scrollHeight, graph.clientHeight);
    this.#svg.setAttribute("width", String(width));
    this.#svg.setAttribute("height", String(height));
    this.#svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const base = canvas.getBoundingClientRect();

    for (const connection of this.#connections) {
      if (affectedTaskIds && !intersects(connection.taskIds, affectedTaskIds)) continue;
      const path = this.#paths.get(connection.key);
      if (!path) continue;
      const data = connection.kind === "parent"
        ? parentPath(connection, resolve, base)
        : dependencyPath(connection, resolve, base);
      if (data === null) path.removeAttribute("d");
      else if (path.getAttribute("d") !== data) path.setAttribute("d", data);
    }
  }

  dispose(): void {
    this.#connections = [];
    for (const path of this.#paths.values()) path.remove();
    this.#paths.clear();
    this.#defs.remove();
  }

  #createMarker(): SVGDefsElement {
    const defs = this.#document.createElementNS(SVG_NAMESPACE, "defs");
    const marker = this.#document.createElementNS(SVG_NAMESPACE, "marker");
    marker.setAttribute("id", this.#markerId);
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "4");
    marker.setAttribute("orient", "auto");
    const arrow = this.#document.createElementNS(SVG_NAMESPACE, "path");
    arrow.setAttribute("d", "M0,0 L8,4 L0,8 Z");
    arrow.setAttribute("fill", "#168a53");
    marker.append(arrow);
    defs.append(marker);
    return defs;
  }
}

function collectConnections(root: TodoTask): readonly TaskGraphConnection[] {
  const descendants = new Map<string, ReadonlySet<string>>();
  const collectDescendants = (task: TodoTask): ReadonlySet<string> => {
    const ids = new Set<string>([task.id]);
    for (const child of task.children) {
      for (const id of collectDescendants(child)) ids.add(id);
    }
    descendants.set(task.id, ids);
    return ids;
  };
  collectDescendants(root);

  const result: TaskGraphConnection[] = [];
  const visit = (parent: TodoTask): void => {
    if (parent.id !== root.id && parent.children.length > 0) {
      result.push({
        key: `parent:${parent.id}`,
        kind: "parent",
        parentId: parent.id,
        childIds: parent.children.map((child) => child.id),
        taskIds: new Set([
          parent.id,
          ...parent.children.flatMap((child) => [...(descendants.get(child.id) ?? [child.id])]),
        ]),
      });
    }
    for (const child of parent.children) {
      if (child.predecessorId !== null) {
        result.push({
          key: `dependency:${child.predecessorId}->${child.id}`,
          kind: "dependency",
          predecessorId: child.predecessorId,
          successorId: child.id,
          taskIds: new Set([
            ...(descendants.get(child.predecessorId) ?? [child.predecessorId]),
            ...(descendants.get(child.id) ?? [child.id]),
          ]),
        });
      }
      visit(child);
    }
  };
  visit(root);
  return result;
}

function parentPath(
  connection: Extract<TaskGraphConnection, { readonly kind: "parent" }>,
  resolve: (taskId: string) => TaskGraphConnectionElements | null,
  base: DOMRect,
): string | null {
  const parent = resolve(connection.parentId)?.node;
  const children = connection.childIds
    .map((taskId) => resolve(taskId)?.node ?? null)
    .filter((node): node is HTMLElement => node !== null);
  if (!parent || children.length === 0) return null;
  const from = point(parent, "bottom", base);
  const targets = children.map((child) => point(child, "top", base));
  const firstChildY = Math.min(...targets.map((target) => target.y));
  const busY = from.y + (firstChildY - from.y) / 2;
  const left = Math.min(from.x, ...targets.map((target) => target.x));
  const right = Math.max(from.x, ...targets.map((target) => target.x));
  const branches = targets.map((target) => `M${target.x},${busY} V${target.y}`).join(" ");
  return `M${from.x},${from.y} V${busY} M${left},${busY} H${right} ${branches}`;
}

function dependencyPath(
  connection: Extract<TaskGraphConnection, { readonly kind: "dependency" }>,
  resolve: (taskId: string) => TaskGraphConnectionElements | null,
  base: DOMRect,
): string | null {
  const predecessor = dependencyBox(resolve(connection.predecessorId));
  const successor = dependencyBox(resolve(connection.successorId));
  if (!predecessor || !successor) return null;
  const from = point(predecessor, "right", base);
  const to = point(successor, "left", base);
  const middle = (from.x + to.x) / 2;
  return `M${from.x},${from.y} H${middle} V${to.y} H${to.x}`;
}

function dependencyBox(elements: TaskGraphConnectionElements | null): HTMLElement | null {
  if (!elements) return null;
  return elements.subtree.classList.contains("has-children")
    ? elements.subtree
    : elements.node;
}

function point(
  element: HTMLElement,
  side: "top" | "bottom" | "left" | "right",
  base: DOMRect,
): Point {
  const rect = element.getBoundingClientRect();
  const x = side === "left" ? rect.left : side === "right" ? rect.right : rect.left + rect.width / 2;
  const y = side === "top" ? rect.top : side === "bottom" ? rect.bottom : rect.top + rect.height / 2;
  return { x: x - base.left, y: y - base.top };
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
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
