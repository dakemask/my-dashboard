import {
  CONNECTOR_SIDES,
  type MindMapBracket,
  type MindMapDocument,
  type MindMapEndpoint,
  type MindMapNode,
  type NodeFrame,
} from "../domain";
import {
  arrowLine,
  bracketCenterPoint,
  bracketPathData,
  connectorMidpoint,
  normalizeRect,
  type Point,
  type Rect,
} from "./geometry";
import type { BracketHandle, PointerInteraction } from "./interactionController";
import { KeyedSvgRenderer } from "./keyedSvgRenderer";
import type { CanvasViewport } from "./viewport";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const GRID_EXTENT = 100_000;
const BRACKET_HANDLES = ["from", "center", "to"] as const satisfies readonly BracketHandle[];

export interface CanvasRendererProjection {
  readonly arrowMode: boolean;
  readonly selectedNodeIds: ReadonlySet<string>;
  readonly selectedBracketIds: ReadonlySet<string>;
  readonly selectedArrowIds: ReadonlySet<string>;
  readonly interaction: PointerInteraction;
  readonly editingNodeId: string | null;
  readonly frameForNode: (node: MindMapNode) => NodeFrame;
  readonly bracketFor: (bracket: MindMapBracket) => MindMapBracket;
}

export interface CanvasSvgRendererCallbacks {
  readonly onArrowPointerDown: (event: PointerEvent, arrowId: string) => void;
  readonly onTextPointerDown: (
    event: PointerEvent,
    nodeId: string,
    textarea: HTMLTextAreaElement,
  ) => void;
  readonly onTextClick: (event: MouseEvent, nodeId: string) => void;
  readonly onTextBlur: (nodeId: string) => void;
  readonly onTextInput: (nodeId: string) => void;
  readonly onNodeMovePointerDown: (event: PointerEvent, nodeId: string) => void;
  readonly onResizePointerDown: (event: PointerEvent, nodeId: string) => void;
  readonly onBracketPointerDown: (event: PointerEvent, bracketId: string) => void;
  readonly onBracketHandlePointerDown: (
    event: PointerEvent,
    bracketId: string,
    handle: BracketHandle,
  ) => void;
  readonly onConnectorPointerDown: (event: PointerEvent, endpoint: MindMapEndpoint) => void;
}

interface ArrowRenderItem {
  readonly id: string;
  readonly from: Point;
  readonly to: Point;
}

type OverlayRenderItem =
  | { readonly kind: "marquee"; readonly rect: Rect }
  | { readonly kind: "connecting"; readonly from: Point; readonly to: Point };

/** Owns keyed SVG/textarea projection while business interaction state stays in the canvas facade. */
export class MindMapSvgRenderer {
  readonly element: SVGSVGElement;
  readonly #ownerDocument: Document;
  readonly #callbacks: CanvasSvgRendererCallbacks;
  readonly #viewportLayer: SVGGElement;
  readonly #grid: SVGRectElement;
  readonly #bracketLayer: SVGGElement;
  readonly #arrowLayer: SVGGElement;
  readonly #nodeLayer: SVGGElement;
  readonly #overlayLayer: SVGGElement;
  readonly #markerId: string;
  readonly #bracketRenderer: KeyedSvgRenderer<MindMapBracket, SVGGElement>;
  readonly #arrowRenderer: KeyedSvgRenderer<ArrowRenderItem, SVGGElement>;
  readonly #nodeRenderer: KeyedSvgRenderer<MindMapNode, SVGGElement>;
  readonly #overlayRenderer: KeyedSvgRenderer<OverlayRenderItem, SVGElement>;
  #projection: CanvasRendererProjection | null = null;
  #suppressBlur = false;

  constructor(ownerDocument: Document, callbacks: CanvasSvgRendererCallbacks) {
    this.#ownerDocument = ownerDocument;
    this.#callbacks = callbacks;
    this.#markerId = `mind-maps-arrow-${Math.random().toString(16).slice(2)}`;
    this.element = createSvg(ownerDocument, "svg");
    this.element.classList.add("mind-maps-canvas");
    this.element.setAttribute("role", "application");
    this.element.setAttribute("aria-label", "思维导图画布");
    this.element.setAttribute("tabindex", "0");
    this.element.append(this.#createDefinitions());

    this.#viewportLayer = createSvg(ownerDocument, "g");
    this.#viewportLayer.classList.add("mind-maps-canvas__viewport");
    this.#grid = createSvg(ownerDocument, "rect");
    this.#grid.classList.add("mind-maps-canvas__grid");
    this.#grid.setAttribute("x", String(-GRID_EXTENT));
    this.#grid.setAttribute("y", String(-GRID_EXTENT));
    this.#grid.setAttribute("width", String(GRID_EXTENT * 2));
    this.#grid.setAttribute("height", String(GRID_EXTENT * 2));
    this.#grid.setAttribute("fill", `url(#${this.#markerId}-grid)`);

    this.#bracketLayer = createSvg(ownerDocument, "g");
    this.#bracketLayer.classList.add("mind-maps-canvas__brackets");
    this.#arrowLayer = createSvg(ownerDocument, "g");
    this.#arrowLayer.classList.add("mind-maps-canvas__arrows");
    this.#nodeLayer = createSvg(ownerDocument, "g");
    this.#nodeLayer.classList.add("mind-maps-canvas__nodes");
    this.#overlayLayer = createSvg(ownerDocument, "g");
    this.#overlayLayer.classList.add("mind-maps-canvas__overlays");
    this.#viewportLayer.append(
      this.#grid,
      this.#bracketLayer,
      this.#arrowLayer,
      this.#nodeLayer,
      this.#overlayLayer,
    );
    this.element.append(this.#viewportLayer);

    this.#bracketRenderer = new KeyedSvgRenderer(this.#bracketLayer, {
      key: (bracket) => bracket.id,
      create: (bracket) => this.#createBracketElement(bracket.id),
      update: (element, bracket) => this.#updateBracketElement(element, bracket),
    });
    this.#arrowRenderer = new KeyedSvgRenderer(this.#arrowLayer, {
      key: (item) => item.id,
      create: (item) => this.#createArrowElement(item.id),
      update: (element, item) => this.#updateArrowElement(element, item),
    });
    this.#nodeRenderer = new KeyedSvgRenderer(this.#nodeLayer, {
      key: (node) => node.id,
      create: (node) => this.#createNodeElement(node),
      update: (element, node) => this.#updateNodeElement(element, node),
    });
    this.#overlayRenderer = new KeyedSvgRenderer(this.#overlayLayer, {
      key: (item) => item.kind,
      create: (item) => this.#createOverlayElement(item),
      update: (element, item) => this.#updateOverlayElement(element, item),
    });
  }

  isBlankTarget(target: EventTarget | null): boolean {
    return target === this.element || target === this.#grid;
  }

  findTextarea(nodeId: string): HTMLTextAreaElement | null {
    return this.#nodeRenderer.get(nodeId)
      ?.querySelector<HTMLTextAreaElement>(".mind-maps-canvas__node-editor") ?? null;
  }

  setViewport(viewport: CanvasViewport): void {
    this.#viewportLayer.setAttribute(
      "transform",
      `translate(${viewport.offsetX} ${viewport.offsetY}) scale(${viewport.scale})`,
    );
  }

  clear(): void {
    this.#bracketRenderer.clear();
    this.#arrowRenderer.clear();
    this.#nodeRenderer.clear();
    this.#overlayRenderer.clear();
  }

  render(map: MindMapDocument | null, projection: CanvasRendererProjection): void {
    this.#projection = projection;
    this.#updateRootClasses();
    this.#suppressBlur = true;
    try {
      if (!map) {
        this.clear();
        return;
      }
      this.#bracketRenderer.render(this.#orderedBrackets(map));
      this.renderArrows(map, projection);
      this.#nodeRenderer.render(this.#orderedNodes(map));
      this.renderOverlay(map, projection);
    } finally {
      this.#suppressBlur = false;
    }
  }

  syncInteractionChrome(map: MindMapDocument, projection: CanvasRendererProjection): void {
    this.#projection = projection;
    this.#updateRootClasses();
    for (const bracket of map.brackets) {
      const group = this.#bracketRenderer.get(bracket.id);
      if (group) this.#updateBracketElement(group, bracket);
    }
    this.renderArrows(map, projection);
    for (const node of map.nodes) {
      const group = this.#nodeRenderer.get(node.id);
      if (group) this.#updateNodeElement(group, node);
    }
    this.renderOverlay(map, projection);
  }

  updateSelectionChrome(map: MindMapDocument, projection: CanvasRendererProjection): void {
    this.#projection = projection;
    this.#updateRootClasses();
    for (const bracket of map.brackets) {
      const group = this.#bracketRenderer.get(bracket.id);
      if (group) this.#updateBracketElement(group, bracket);
    }
    this.#bracketRenderer.reorder(this.#orderedBrackets(map).map((bracket) => bracket.id));
    for (const arrow of map.arrows) {
      const group = this.#arrowRenderer.get(arrow.id);
      if (!group) continue;
      const selected = projection.selectedArrowIds.has(arrow.id);
      group.classList.toggle("is-selected", selected);
      group.querySelector<SVGLineElement>(".mind-maps-canvas__arrow-line")?.setAttribute(
        "marker-end",
        `url(#${selected ? `${this.#markerId}-selected` : this.#markerId})`,
      );
    }
    for (const node of map.nodes) {
      const group = this.#nodeRenderer.get(node.id);
      if (group) this.#updateNodeChrome(group, node, projection.frameForNode(node));
    }
    this.#nodeRenderer.reorder(this.#orderedNodes(map).map((node) => node.id));
  }

  updateBracketPreview(
    map: MindMapDocument,
    bracketId: string,
    projection: CanvasRendererProjection,
  ): void {
    this.#projection = projection;
    const bracket = map.brackets.find((candidate) => candidate.id === bracketId);
    const group = this.#bracketRenderer.get(bracketId);
    if (bracket && group) this.#updateBracketElement(group, bracket);
  }

  updateNodePreview(
    map: MindMapDocument,
    nodeId: string,
    projection: CanvasRendererProjection,
  ): void {
    this.#projection = projection;
    const node = map.nodes.find((candidate) => candidate.id === nodeId);
    const group = this.#nodeRenderer.get(nodeId);
    if (!node || !group) return;
    const frame = projection.frameForNode(node);
    this.#updateNodeChrome(group, node, frame);
    this.#updateNodeGeometry(group, frame, this.#nodeEditorHeight(node.id, frame));
    this.#updateNodeConnectors(group, node, frame);
  }

  updateArrowsForNodeIds(
    map: MindMapDocument,
    nodeIds: readonly string[],
    projection: CanvasRendererProjection,
  ): void {
    this.#projection = projection;
    if (nodeIds.length === 0) return;
    const affected = new Set(nodeIds);
    const nodes = new Map(map.nodes.map((node) => [node.id, node]));
    for (const arrow of map.arrows) {
      if (!affected.has(arrow.from.nodeId) && !affected.has(arrow.to.nodeId)) continue;
      const line = arrowLine(arrow, nodes, projection.frameForNode);
      const group = this.#arrowRenderer.get(arrow.id);
      if (line && group) {
        this.#updateArrowElement(group, { id: arrow.id, from: line.from, to: line.to });
      }
    }
  }

  updateConnectorChrome(
    map: MindMapDocument,
    nodeIds: readonly string[],
    projection: CanvasRendererProjection,
  ): void {
    this.#projection = projection;
    for (const nodeId of new Set(nodeIds)) {
      const node = map.nodes.find((candidate) => candidate.id === nodeId);
      const group = this.#nodeRenderer.get(nodeId);
      if (node && group) this.#updateNodeConnectors(group, node, projection.frameForNode(node));
    }
  }

  applyEditingFrame(nodeId: string, frame: NodeFrame): void {
    const group = this.#nodeRenderer.get(nodeId);
    if (!group) return;
    this.#updateNodeGeometry(group, frame, frame.height);
    const resizeControl = group.querySelector<SVGGElement>(".mind-maps-canvas__resize-control");
    if (resizeControl) this.#updateResizeHandle(resizeControl, frame);
  }

  renderArrows(
    map: MindMapDocument,
    projection: CanvasRendererProjection,
    nodes: ReadonlyMap<string, MindMapNode> = new Map(map.nodes.map((node) => [node.id, node])),
  ): void {
    this.#projection = projection;
    const items: ArrowRenderItem[] = [];
    for (const arrow of map.arrows) {
      const line = arrowLine(arrow, nodes, projection.frameForNode);
      if (line) items.push({ id: arrow.id, from: line.from, to: line.to });
    }
    this.#arrowRenderer.render(items);
  }

  renderOverlay(map: MindMapDocument, projection: CanvasRendererProjection): void {
    this.#projection = projection;
    const interaction = projection.interaction;
    if (interaction.kind === "marquee") {
      this.#overlayRenderer.render([{
        kind: "marquee",
        rect: normalizeRect(interaction.startWorld, interaction.currentWorld),
      }]);
      return;
    }
    if (interaction.kind === "connecting") {
      const sourceNode = map.nodes.find((node) => node.id === interaction.from.nodeId);
      if (!sourceNode) {
        this.#overlayRenderer.clear();
        return;
      }
      const from = connectorMidpoint(projection.frameForNode(sourceNode), interaction.from.side);
      const toNode = interaction.target
        ? map.nodes.find((node) => node.id === interaction.target?.nodeId)
        : null;
      const to = interaction.target && toNode
        ? connectorMidpoint(projection.frameForNode(toNode), interaction.target.side)
        : interaction.currentWorld;
      this.#overlayRenderer.render([{ kind: "connecting", from, to }]);
      return;
    }
    this.#overlayRenderer.clear();
  }

  #orderedNodes(map: MindMapDocument): MindMapNode[] {
    return map.nodes
      .map((node, index) => ({ node, index, rank: this.#nodeRaiseRank(node.id) }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((item) => item.node);
  }

  #orderedBrackets(map: MindMapDocument): MindMapBracket[] {
    return map.brackets
      .map((bracket, index) => ({
        bracket,
        index,
        selected: this.#requireProjection().selectedBracketIds.has(bracket.id) ? 1 : 0,
      }))
      .sort((left, right) => left.selected - right.selected || left.index - right.index)
      .map((item) => item.bracket);
  }

  #createBracketElement(id: string): SVGGElement {
    const group = createSvg(this.#ownerDocument, "g");
    group.classList.add("mind-maps-canvas__bracket");
    group.dataset.bracketId = id;
    const line = createSvg(this.#ownerDocument, "path");
    line.classList.add("mind-maps-canvas__bracket-line");
    const hit = createSvg(this.#ownerDocument, "path");
    hit.classList.add("mind-maps-canvas__bracket-hit");
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "22");
    hit.setAttribute("pointer-events", "stroke");
    hit.addEventListener("pointerdown", (event) => {
      this.#callbacks.onBracketPointerDown(event, id);
    });
    group.append(line, hit);
    return group;
  }

  #updateBracketElement(group: SVGGElement, source: MindMapBracket): void {
    const projection = this.#requireProjection();
    const bracket = projection.bracketFor(source);
    const selected = projection.selectedBracketIds.has(bracket.id);
    group.classList.toggle("is-selected", selected);
    const path = bracketPathData(bracket);
    group.querySelector<SVGPathElement>(".mind-maps-canvas__bracket-line")
      ?.setAttribute("d", path);
    group.querySelector<SVGPathElement>(".mind-maps-canvas__bracket-hit")
      ?.setAttribute("d", path);

    const controls = new Map<BracketHandle, SVGGElement>();
    for (const control of group.querySelectorAll<SVGGElement>(
      ".mind-maps-canvas__bracket-control",
    )) {
      const handle = control.dataset.handle;
      if (handle === "from" || handle === "center" || handle === "to") {
        controls.set(handle, control);
      }
    }
    if (!selected) {
      for (const control of controls.values()) control.remove();
      return;
    }

    const points: Record<BracketHandle, Point> = {
      from: bracket.from,
      center: bracketCenterPoint(bracket),
      to: bracket.to,
    };
    for (const handle of BRACKET_HANDLES) {
      let control = controls.get(handle);
      if (!control) {
        control = this.#createBracketHandle(bracket.id, handle);
        group.append(control);
      }
      const point = points[handle];
      control.setAttribute("transform", `translate(${point.x} ${point.y})`);
      controls.delete(handle);
    }
    for (const control of controls.values()) control.remove();
  }

  #createBracketHandle(bracketId: string, handle: BracketHandle): SVGGElement {
    const control = createSvg(this.#ownerDocument, "g");
    control.classList.add(
      "mind-maps-canvas__bracket-control",
      `mind-maps-canvas__bracket-control--${handle}`,
    );
    control.dataset.handle = handle;
    const hit = createSvg(this.#ownerDocument, "circle");
    hit.classList.add("mind-maps-canvas__bracket-control-hit");
    hit.setAttribute("r", "14");
    hit.addEventListener("pointerdown", (event) => {
      this.#callbacks.onBracketHandlePointerDown(event, bracketId, handle);
    });
    const marker = createSvg(this.#ownerDocument, "circle");
    marker.classList.add("mind-maps-canvas__bracket-control-marker");
    marker.setAttribute("r", handle === "center" ? "5.5" : "5");
    marker.setAttribute("pointer-events", "none");
    control.append(hit, marker);
    return control;
  }

  #createArrowElement(id: string): SVGGElement {
    const group = createSvg(this.#ownerDocument, "g");
    group.classList.add("mind-maps-canvas__arrow");
    group.dataset.arrowId = id;
    const line = createSvg(this.#ownerDocument, "line");
    line.classList.add("mind-maps-canvas__arrow-line");
    const hit = createSvg(this.#ownerDocument, "line");
    hit.classList.add("mind-maps-canvas__arrow-hit");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "14");
    hit.setAttribute("pointer-events", "stroke");
    hit.addEventListener("pointerdown", (event) => this.#callbacks.onArrowPointerDown(event, id));
    group.append(line, hit);
    return group;
  }

  #updateArrowElement(group: SVGGElement, item: ArrowRenderItem): void {
    const selected = this.#requireProjection().selectedArrowIds.has(item.id);
    group.classList.toggle("is-selected", selected);
    const line = group.querySelector<SVGLineElement>(".mind-maps-canvas__arrow-line");
    const hit = group.querySelector<SVGLineElement>(".mind-maps-canvas__arrow-hit");
    if (line) {
      setLine(line, item.from, item.to);
      line.setAttribute(
        "marker-end",
        `url(#${selected ? `${this.#markerId}-selected` : this.#markerId})`,
      );
    }
    if (hit) setLine(hit, item.from, item.to);
  }

  #createNodeElement(node: MindMapNode): SVGGElement {
    const group = createSvg(this.#ownerDocument, "g");
    group.classList.add("mind-maps-canvas__node");
    group.dataset.nodeId = node.id;
    const body = createSvg(this.#ownerDocument, "rect");
    body.classList.add("mind-maps-canvas__node-body");
    const foreignObject = createSvg(this.#ownerDocument, "foreignObject");
    foreignObject.classList.add("mind-maps-canvas__node-editor-host");
    const textarea = this.#ownerDocument.createElementNS(
      XHTML_NAMESPACE,
      "textarea",
    ) as HTMLTextAreaElement;
    textarea.classList.add("mind-maps-canvas__node-editor");
    textarea.dataset.nodeId = node.id;
    textarea.value = node.text;
    textarea.setAttribute("aria-label", "节点文本");
    textarea.addEventListener("pointerdown", (event) => {
      this.#callbacks.onTextPointerDown(event, node.id, textarea);
    });
    textarea.addEventListener("click", (event) => this.#callbacks.onTextClick(event, node.id));
    textarea.addEventListener("blur", () => {
      if (!this.#suppressBlur) this.#callbacks.onTextBlur(node.id);
    });
    textarea.addEventListener("compositionstart", () => {
      textarea.dataset.composing = "true";
    });
    textarea.addEventListener("compositionend", () => {
      delete textarea.dataset.composing;
      this.#callbacks.onTextInput(node.id);
    });
    textarea.addEventListener("input", () => this.#callbacks.onTextInput(node.id));
    foreignObject.append(textarea);
    const moveHit = createSvg(this.#ownerDocument, "rect");
    moveHit.classList.add("mind-maps-canvas__node-move-hit");
    moveHit.setAttribute("x", "0");
    moveHit.setAttribute("y", "0");
    moveHit.setAttribute("fill", "none");
    moveHit.setAttribute("stroke", "transparent");
    moveHit.setAttribute("stroke-width", "14");
    moveHit.setAttribute("pointer-events", "stroke");
    moveHit.addEventListener("pointerdown", (event) => {
      this.#callbacks.onNodeMovePointerDown(event, node.id);
    });
    group.append(body, foreignObject, moveHit);
    return group;
  }

  #updateNodeElement(group: SVGGElement, node: MindMapNode): void {
    const projection = this.#requireProjection();
    const frame = projection.frameForNode(node);
    this.#updateNodeChrome(group, node, frame);
    this.#updateNodeGeometry(group, frame, this.#nodeEditorHeight(node.id, frame));
    this.#updateNodeConnectors(group, node, frame);
  }

  #updateNodeChrome(group: SVGGElement, node: MindMapNode, frame: NodeFrame): void {
    const projection = this.#requireProjection();
    group.classList.remove("is-idle", "is-moving", "is-resizing", "is-editing");
    group.classList.add(this.#nodeStateClass(node.id));
    group.classList.toggle("is-selected", projection.selectedNodeIds.has(node.id));
    group.classList.toggle("is-raised", this.#nodeRaiseRank(node.id) > 0);
    const textarea = group.querySelector<HTMLTextAreaElement>(".mind-maps-canvas__node-editor");
    if (textarea) {
      const editing = projection.editingNodeId === node.id;
      textarea.readOnly = !editing;
      textarea.tabIndex = editing ? 0 : -1;
      if (!editing && textarea.dataset.composing !== "true" && textarea.value !== node.text) {
        textarea.value = node.text;
      }
    }
    let resizeControl = group.querySelector<SVGGElement>(".mind-maps-canvas__resize-control");
    if (!this.#shouldShowResizeHandle(node.id)) {
      resizeControl?.remove();
    } else {
      if (!resizeControl) {
        resizeControl = this.#createResizeHandle(node.id);
        group.append(resizeControl);
      }
      this.#updateResizeHandle(resizeControl, frame);
    }
  }

  #updateNodeConnectors(group: SVGGElement, node: MindMapNode, frame: NodeFrame): void {
    const projection = this.#requireProjection();
    const connectors = new Map<string, SVGCircleElement>();
    for (const connector of group.querySelectorAll<SVGCircleElement>(".mind-maps-canvas__connector")) {
      if (connector.dataset.side) connectors.set(connector.dataset.side, connector);
    }
    if (!projection.arrowMode) {
      for (const connector of connectors.values()) connector.remove();
      return;
    }
    for (const side of CONNECTOR_SIDES) {
      const endpoint = { nodeId: node.id, side } satisfies MindMapEndpoint;
      let connector = connectors.get(side);
      if (!connector) {
        connector = createSvg(this.#ownerDocument, "circle");
        connector.classList.add("mind-maps-canvas__connector", `mind-maps-canvas__connector--${side}`);
        connector.dataset.nodeId = node.id;
        connector.dataset.side = side;
        connector.setAttribute("r", "3.5");
        connector.addEventListener("pointerdown", (event) => {
          this.#callbacks.onConnectorPointerDown(event, endpoint);
        });
        group.append(connector);
      }
      const point = connectorMidpoint({ x: 0, y: 0, width: frame.width, height: frame.height }, side);
      connector.setAttribute("cx", String(point.x));
      connector.setAttribute("cy", String(point.y));
      connector.classList.toggle("is-target", endpointEqual(this.#connectingTarget(), endpoint));
      connector.classList.toggle("is-source", endpointEqual(this.#connectingSource(), endpoint));
      connectors.delete(side);
    }
    for (const connector of connectors.values()) connector.remove();
  }

  #updateNodeGeometry(group: SVGGElement, frame: NodeFrame, editorHeight: number): void {
    group.setAttribute("transform", `translate(${frame.x} ${frame.y})`);
    for (const element of group.querySelectorAll<SVGRectElement>(
      ".mind-maps-canvas__node-body, .mind-maps-canvas__node-move-hit",
    )) {
      element.setAttribute("width", String(frame.width));
      element.setAttribute("height", String(frame.height));
    }
    const foreignObject = group.querySelector<SVGForeignObjectElement>(
      ".mind-maps-canvas__node-editor-host",
    );
    foreignObject?.setAttribute("width", String(frame.width));
    foreignObject?.setAttribute("height", String(editorHeight));
  }

  #createResizeHandle(nodeId: string): SVGGElement {
    const control = createSvg(this.#ownerDocument, "g");
    control.classList.add("mind-maps-canvas__resize-control");
    const hit = createSvg(this.#ownerDocument, "rect");
    hit.classList.add("mind-maps-canvas__resize-hit");
    hit.dataset.nodeId = nodeId;
    hit.setAttribute("width", "20");
    hit.setAttribute("height", "20");
    hit.setAttribute("fill", "transparent");
    hit.addEventListener("pointerdown", (event) => {
      this.#callbacks.onResizePointerDown(event, nodeId);
    });
    const handle = createSvg(this.#ownerDocument, "rect");
    handle.classList.add("mind-maps-canvas__resize-handle");
    handle.setAttribute("width", "8");
    handle.setAttribute("height", "8");
    handle.setAttribute("pointer-events", "none");
    control.append(hit, handle);
    return control;
  }

  #updateResizeHandle(control: SVGGElement, frame: NodeFrame): void {
    const hit = control.querySelector<SVGRectElement>(".mind-maps-canvas__resize-hit");
    hit?.setAttribute("x", String(frame.width - 10));
    hit?.setAttribute("y", String(frame.height - 10));
    const handle = control.querySelector<SVGRectElement>(".mind-maps-canvas__resize-handle");
    handle?.setAttribute("x", String(frame.width - 4));
    handle?.setAttribute("y", String(frame.height - 4));
  }

  #createOverlayElement(item: OverlayRenderItem): SVGElement {
    if (item.kind === "marquee") {
      const element = createSvg(this.#ownerDocument, "rect");
      element.classList.add("mind-maps-canvas__marquee");
      return element;
    }
    const element = createSvg(this.#ownerDocument, "line");
    element.classList.add("mind-maps-canvas__arrow-preview");
    return element;
  }

  #updateOverlayElement(element: SVGElement, item: OverlayRenderItem): void {
    if (item.kind === "marquee") setRect(element as SVGRectElement, item.rect);
    else setLine(element as SVGLineElement, item.from, item.to);
  }

  #updateRootClasses(): void {
    const projection = this.#requireProjection();
    this.element.classList.toggle("is-arrow-mode", projection.arrowMode);
    for (const kind of [
      "marquee",
      "moving",
      "resizing",
      "adjusting-bracket",
      "connecting",
      "panning",
    ] as const) {
      this.element.classList.toggle(`is-${kind}`, projection.interaction.kind === kind);
    }
  }

  #nodeStateClass(nodeId: string): string {
    const projection = this.#requireProjection();
    if (projection.editingNodeId === nodeId) return "is-editing";
    if (
      projection.interaction.kind === "resizing"
      && projection.interaction.nodeId === nodeId
      && projection.interaction.moved
    ) return "is-resizing";
    if (projection.selectedNodeIds.has(nodeId)) return "is-moving";
    return "is-idle";
  }

  #nodeEditorHeight(nodeId: string, frame: NodeFrame): number {
    const interaction = this.#requireProjection().interaction;
    return interaction.kind === "resizing" && interaction.nodeId === nodeId
      ? Math.max(frame.height, interaction.textPaintHeight)
      : frame.height;
  }

  #nodeRaiseRank(nodeId: string): number {
    const projection = this.#requireProjection();
    const interaction = projection.interaction;
    if (
      projection.editingNodeId === nodeId
      || (interaction.kind === "resizing" && interaction.nodeId === nodeId)
      || (interaction.kind === "moving" && interaction.nodeIds.includes(nodeId))
    ) return 2;
    return projection.selectedNodeIds.has(nodeId) ? 1 : 0;
  }

  #shouldShowResizeHandle(nodeId: string): boolean {
    const projection = this.#requireProjection();
    if (projection.editingNodeId === nodeId) return true;
    return (
      projection.selectedNodeIds.size === 1
      && projection.selectedArrowIds.size === 0
      && projection.selectedNodeIds.has(nodeId)
    );
  }

  #connectingSource(): MindMapEndpoint | null {
    const interaction = this.#requireProjection().interaction;
    return interaction.kind === "connecting" ? interaction.from : null;
  }

  #connectingTarget(): MindMapEndpoint | null {
    const interaction = this.#requireProjection().interaction;
    return interaction.kind === "connecting" ? interaction.target : null;
  }

  #requireProjection(): CanvasRendererProjection {
    if (!this.#projection) throw new Error("Canvas renderer has no projection.");
    return this.#projection;
  }

  #createDefinitions(): SVGDefsElement {
    const defs = createSvg(this.#ownerDocument, "defs");
    const createArrowMarker = (id: string, selected: boolean): SVGMarkerElement => {
      const marker = createSvg(this.#ownerDocument, "marker");
      marker.id = id;
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "7");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("orient", "auto");
      const arrowHead = createSvg(this.#ownerDocument, "path");
      arrowHead.classList.add("mind-maps-canvas__arrow-head");
      if (selected) arrowHead.classList.add("is-selected");
      arrowHead.setAttribute("d", "M 1 1.7 L 10 5 L 1 8.3 z");
      marker.append(arrowHead);
      return marker;
    };
    const pattern = createSvg(this.#ownerDocument, "pattern");
    pattern.id = `${this.#markerId}-grid`;
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    pattern.setAttribute("width", "24");
    pattern.setAttribute("height", "24");
    const gridDot = createSvg(this.#ownerDocument, "circle");
    gridDot.classList.add("mind-maps-canvas__grid-dot");
    gridDot.setAttribute("cx", "1");
    gridDot.setAttribute("cy", "1");
    gridDot.setAttribute("r", "1.15");
    pattern.append(gridDot);
    defs.append(
      createArrowMarker(this.#markerId, false),
      createArrowMarker(`${this.#markerId}-selected`, true),
      pattern,
    );
    return defs;
  }
}

function createSvg<K extends keyof SVGElementTagNameMap>(
  ownerDocument: Document,
  name: K,
): SVGElementTagNameMap[K] {
  return ownerDocument.createElementNS(SVG_NAMESPACE, name);
}

function endpointEqual(left: MindMapEndpoint | null, right: MindMapEndpoint): boolean {
  return left?.nodeId === right.nodeId && left.side === right.side;
}

function setLine(line: SVGLineElement, from: Point, to: Point): void {
  line.setAttribute("x1", String(from.x));
  line.setAttribute("y1", String(from.y));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y));
}

function setRect(element: SVGRectElement, rect: Rect): void {
  element.setAttribute("x", String(rect.x));
  element.setAttribute("y", String(rect.y));
  element.setAttribute("width", String(rect.width));
  element.setAttribute("height", String(rect.height));
}
