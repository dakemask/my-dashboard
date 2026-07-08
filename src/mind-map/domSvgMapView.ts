import { DEFAULT_NODE_WIDTH } from "./mindMap";
import {
  RESIZE_HANDLES,
  VISUAL_MIN_SIZE,
  clamp,
  getEndpointPoint,
  getNodeFrame,
  isSameFrame,
  modulo,
  moveFrame,
  resizeFrame,
  type Point,
  type ResizeHandle,
} from "./nodeFrame";
import { TextBoxLayout, type TextEditSnapshot } from "./textBoxLayout";
import type {
  ConnectorSide,
  MindMapArrow,
  MindMapData,
  MindMapEndpoint,
  MindMapNode,
  MindMapSelection,
  NodeFrame,
} from "./types";

interface MapViewCallbacks {
  onSelectionChange: (selection: MindMapSelection) => void;
  onNodeFrameChange: (id: string, frame: NodeFrame) => void;
  onNodeTextChange: (id: string, text: string, frame?: NodeFrame) => void;
  onArrowCreate: (from: MindMapEndpoint, to: MindMapEndpoint) => void;
  onContextMenu: (selection: MindMapSelection, x: number, y: number) => void;
}

interface ArrowElements {
  group: SVGGElement;
  line: SVGLineElement;
  hitLine: SVGLineElement;
}

interface ActiveEdit extends TextEditSnapshot {
  id: string;
}

interface DragState {
  kind: "move" | "resize";
  nodeId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startFrame: NodeFrame;
  currentFrame: NodeFrame;
  moved: boolean;
  handle?: ResizeHandle;
}

interface PanState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startOffset: Point;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const CONNECTOR_SIDES: ConnectorSide[] = ["top", "right", "bottom", "left"];
const GRID_SIZE = 24;
const MAX_SCALE = 2.5;
const MIN_SCALE = 0.25;
const POINTER_MOVE_EPSILON = 2;

export class MindMapView {
  private readonly viewport: HTMLDivElement;
  private readonly arrowSvg: SVGSVGElement;
  private readonly nodeLayer: HTMLDivElement;
  private readonly markerId: string;
  private readonly nodeElements = new Map<string, HTMLDivElement>();
  private readonly arrowElements = new Map<string, ArrowElements>();
  private readonly frameOverrides = new Map<string, NodeFrame>();
  private readonly textLayout: TextBoxLayout;

  private activeDrag: DragState | null = null;
  private activeEdit: ActiveEdit | null = null;
  private connectMode = false;
  private data: MindMapData = {
    nodes: [],
    arrows: [],
  };
  private offset: Point = {
    x: 0,
    y: 0,
  };
  private panState: PanState | null = null;
  private pendingConnector: MindMapEndpoint | null = null;
  private scale = 1;
  private selection: MindMapSelection = null;

  constructor(
    private readonly host: HTMLDivElement,
    private readonly callbacks: MapViewCallbacks,
  ) {
    this.markerId = `mind-map-arrow-head-${Math.random().toString(16).slice(2)}`;
    this.textLayout = new TextBoxLayout(this.host);
    this.host.textContent = "";
    this.host.dataset.mapImplementation = "dom-svg";

    this.viewport = document.createElement("div");
    this.viewport.className = "mind-map-viewport";

    this.arrowSvg = document.createElementNS(SVG_NS, "svg");
    this.arrowSvg.classList.add("mind-map-arrows");
    this.arrowSvg.setAttribute("aria-hidden", "true");
    this.arrowSvg.append(this.createArrowMarker());

    this.nodeLayer = document.createElement("div");
    this.nodeLayer.className = "mind-map-node-layer";

    this.viewport.append(this.arrowSvg, this.nodeLayer);
    this.host.append(this.viewport);

    this.host.addEventListener("pointerdown", this.handleHostPointerDown);
    this.host.addEventListener("contextmenu", this.handleHostContextMenu);
    this.host.addEventListener("wheel", this.handleWheel, {
      passive: false,
    });

    this.applyViewportTransform();
  }

  render(data: MindMapData, selection: MindMapSelection): void {
    this.data = data;
    this.selection = selection;

    if (this.activeEdit && !this.getNode(this.activeEdit.id)) {
      this.activeEdit = null;
    }

    this.reconcileNodes(data.nodes);
    this.reconcileArrows(data.arrows);
    this.updateNodeSelectionClasses();
    this.updateConnectorState();
    this.updateArrowPositions();
  }

  setConnectMode(enabled: boolean): void {
    this.connectMode = enabled;
    this.host.classList.toggle("connect-mode", enabled);

    if (!enabled) {
      this.pendingConnector = null;
    }

    this.updateConnectorState();
  }

  getNewNodePosition(): Point {
    const rect = this.host.getBoundingClientRect();

    return {
      x: Math.round((rect.width / 2 - this.offset.x) / this.scale - DEFAULT_NODE_WIDTH / 2),
      y: Math.round((rect.height / 2 - this.offset.y) / this.scale - 46),
    };
  }

  resetView(): void {
    if (this.data.nodes.length === 0) {
      this.scale = 1;
      this.offset = {
        x: 0,
        y: 0,
      };
      this.applyViewportTransform();
      return;
    }

    const rect = this.host.getBoundingClientRect();
    const bounds = this.getNodesBounds(this.data.nodes);
    const horizontalPadding = Math.min(160, rect.width * 0.18);
    const verticalPadding = Math.min(150, rect.height * 0.22);
    const availableWidth = Math.max(240, rect.width - horizontalPadding * 2);
    const availableHeight = Math.max(180, rect.height - verticalPadding * 2);
    const nextScale = clamp(
      Math.min(1.35, availableWidth / bounds.width, availableHeight / bounds.height),
      MIN_SCALE,
      MAX_SCALE,
    );

    this.scale = nextScale;
    this.offset = {
      x: Math.round(rect.width / 2 - (bounds.x + bounds.width / 2) * nextScale),
      y: Math.round(rect.height / 2 - (bounds.y + bounds.height / 2) * nextScale),
    };
    this.applyViewportTransform();
  }

  commitActiveEdit(): void {
    const edit = this.activeEdit;

    if (!edit) {
      return;
    }

    const node = this.getNode(edit.id);
    const element = this.nodeElements.get(edit.id);
    const textElement = element?.querySelector<HTMLElement>(".mind-map-node-text");

    if (!node || !element || !textElement) {
      this.activeEdit = null;
      return;
    }

    const text = getEditableText(textElement);
    const baseFrame = this.frameOverrides.get(edit.id) ?? getNodeFrame(node);
    const frame = this.textLayout.getTextFittedFrame(textElement, text, baseFrame, edit);
    const textChanged = text !== node.text;
    const frameChanged = !isSameFrame(frame, getNodeFrame(node));

    this.activeEdit = null;
    this.frameOverrides.delete(edit.id);
    this.applyNodeFrame(element, frame);
    this.updateNodeSelectionClasses();

    if (textChanged || frameChanged) {
      this.callbacks.onNodeTextChange(edit.id, text, frame);
    }
  }

  editNodeText(id: string): void {
    this.beginTextEdit(id, true);
  }

  destroy(): void {
    this.commitActiveEdit();
    this.host.removeEventListener("pointerdown", this.handleHostPointerDown);
    this.host.removeEventListener("contextmenu", this.handleHostContextMenu);
    this.host.removeEventListener("wheel", this.handleWheel);
    this.removeDragListeners();
    this.removePanListeners();
    this.setResizeCursor(null);
    this.nodeElements.clear();
    this.arrowElements.clear();
    this.host.textContent = "";
  }

  private readonly handleHostPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.isBlankTarget(event.target)) {
      return;
    }

    event.preventDefault();
    this.commitActiveEdit();
    this.clearTextFocusAndSelection();
    this.callbacks.onSelectionChange(null);
    this.startPan(event);
  };

  private readonly handleHostContextMenu = (event: MouseEvent): void => {
    if (!this.isBlankTarget(event.target)) {
      return;
    }

    event.preventDefault();
    this.commitActiveEdit();
    this.clearTextFocusAndSelection();
    this.callbacks.onContextMenu(null, event.clientX, event.clientY);
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();

    const rect = this.host.getBoundingClientRect();
    const localPoint = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const worldPoint = this.screenToWorld(event.clientX, event.clientY);
    const scaleFactor = Math.exp(-event.deltaY * 0.001);
    const nextScale = clamp(this.scale * scaleFactor, MIN_SCALE, MAX_SCALE);

    this.scale = nextScale;
    this.offset = {
      x: localPoint.x - worldPoint.x * nextScale,
      y: localPoint.y - worldPoint.y * nextScale,
    };
    this.applyViewportTransform();
  };

  private readonly handlePanPointerMove = (event: PointerEvent): void => {
    const pan = this.panState;

    if (!pan || event.pointerId !== pan.pointerId) {
      return;
    }

    this.offset = {
      x: pan.startOffset.x + event.clientX - pan.startClientX,
      y: pan.startOffset.y + event.clientY - pan.startClientY,
    };
    this.applyViewportTransform();
  };

  private readonly handlePanPointerUp = (event: PointerEvent): void => {
    if (!this.panState || event.pointerId !== this.panState.pointerId) {
      return;
    }

    this.host.classList.remove("panning");
    this.panState = null;
    this.removePanListeners();
    releasePointerCapture(this.host, event.pointerId);
  };

  private readonly handleDragPointerMove = (event: PointerEvent): void => {
    const drag = this.activeDrag;

    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const dx = (event.clientX - drag.startClientX) / this.scale;
    const dy = (event.clientY - drag.startClientY) / this.scale;
    const frame = drag.kind === "move" ? moveFrame(drag.startFrame, dx, dy) : resizeFrame(drag.startFrame, dx, dy, drag.handle);
    const element = this.nodeElements.get(drag.nodeId);

    const wasMoved = drag.moved;

    drag.currentFrame = frame;
    drag.moved ||= Math.abs(event.clientX - drag.startClientX) > POINTER_MOVE_EPSILON;
    drag.moved ||= Math.abs(event.clientY - drag.startClientY) > POINTER_MOVE_EPSILON;
    this.frameOverrides.set(drag.nodeId, frame);

    if (drag.kind === "resize" && !wasMoved && drag.moved) {
      this.updateNodeSelectionClasses();
    }

    if (element) {
      this.applyNodeFrame(element, frame);
    }

    this.updateArrowPositions();
  };

  private readonly handleDragPointerUp = (event: PointerEvent): void => {
    const drag = this.activeDrag;

    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const element = this.nodeElements.get(drag.nodeId);
    const textElement = element?.querySelector<HTMLElement>(".mind-map-node-text") ?? null;
    const node = this.getNode(drag.nodeId);
    const frame = this.textLayout.getCommittedDragFrame({
      kind: drag.kind,
      frame: drag.currentFrame,
      handle: drag.handle,
      textElement,
      node,
    });
    const changed = node ? !isSameFrame(frame, getNodeFrame(node)) : false;

    this.frameOverrides.delete(drag.nodeId);
    this.activeDrag = null;
    this.removeDragListeners();
    this.setResizeCursor(null);
    this.clearTextFocusAndSelection();
    this.updateNodeSelectionClasses();

    if (element) {
      this.applyNodeFrame(element, frame);
      releasePointerCapture(element, event.pointerId);
    }

    if (changed) {
      this.callbacks.onNodeFrameChange(drag.nodeId, frame);
    } else {
      this.updateArrowPositions();
    }
  };

  private reconcileNodes(nodes: MindMapNode[]): void {
    const nextIds = new Set(nodes.map((node) => node.id));

    for (const [id, element] of this.nodeElements) {
      if (!nextIds.has(id)) {
        element.remove();
        this.nodeElements.delete(id);
      }
    }

    for (const node of nodes) {
      let element = this.nodeElements.get(node.id);

      if (!element) {
        element = this.createNodeElement(node.id);
        this.nodeElements.set(node.id, element);
        this.nodeLayer.append(element);
      }

      this.syncNodeElement(element, node);
    }
  }

  private reconcileArrows(arrows: MindMapArrow[]): void {
    const nextIds = new Set(arrows.map((arrow) => arrow.id));

    for (const [id, elements] of this.arrowElements) {
      if (!nextIds.has(id)) {
        elements.group.remove();
        this.arrowElements.delete(id);
      }
    }

    for (const arrow of arrows) {
      if (!this.arrowElements.has(arrow.id)) {
        const elements = this.createArrowElements(arrow.id);
        this.arrowElements.set(arrow.id, elements);
        this.arrowSvg.append(elements.group);
      }
    }
  }

  private createNodeElement(id: string): HTMLDivElement {
    const nodeElement = document.createElement("div");
    nodeElement.className = "mind-map-node";
    nodeElement.dataset.nodeId = id;
    nodeElement.tabIndex = -1;

    const textElement = document.createElement("div");
    textElement.className = "mind-map-node-text";
    setTextEditingEnabled(textElement, false);
    textElement.setAttribute("role", "textbox");
    textElement.setAttribute("aria-multiline", "true");
    textElement.spellcheck = false;

    textElement.addEventListener("pointerdown", (event) => this.handleTextPointerDown(event, id));
    textElement.addEventListener("focus", () => this.beginTextEdit(id, false));
    textElement.addEventListener("input", () => this.updateEditingPreview(id));
    textElement.addEventListener("paste", (event) => this.handleTextPaste(event, id));
    textElement.addEventListener("keydown", (event) => this.handleTextKeyDown(event, id));
    textElement.addEventListener("blur", () => this.handleTextBlur(id));
    textElement.addEventListener("contextmenu", (event) => this.handleTextContextMenu(event, id));

    nodeElement.addEventListener("contextmenu", (event) => this.handleNodeContextMenu(event, id));

    nodeElement.append(textElement);

    for (const side of CONNECTOR_SIDES) {
      const borderHit = document.createElement("div");

      borderHit.className = `mind-map-border-hit mind-map-border-hit-${side}`;
      borderHit.setAttribute("aria-hidden", "true");
      borderHit.addEventListener("pointerdown", (event) => this.handleNodePointerDown(event, id));
      nodeElement.append(borderHit);
    }

    for (const handle of RESIZE_HANDLES) {
      const handleElement = document.createElement("button");
      handleElement.type = "button";
      handleElement.className = `mind-map-handle mind-map-handle-${handle}`;
      handleElement.setAttribute("aria-label", `缩放 ${handle}`);
      handleElement.addEventListener("pointerdown", (event) => this.handleResizePointerDown(event, id, handle));
      nodeElement.append(handleElement);
    }

    for (const side of CONNECTOR_SIDES) {
      const connector = document.createElement("button");
      connector.type = "button";
      connector.className = `mind-map-connector mind-map-connector-${side}`;
      connector.dataset.side = side;
      connector.setAttribute("aria-label", `${side} 连接点`);
      connector.addEventListener("pointerdown", (event) => this.handleConnectorPointerDown(event));
      connector.addEventListener("click", (event) => this.handleConnectorClick(event, id, side));
      nodeElement.append(connector);
    }

    return nodeElement;
  }

  private createArrowMarker(): SVGDefsElement {
    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    const path = document.createElementNS(SVG_NS, "path");

    marker.id = this.markerId;
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto");
    marker.setAttribute("markerUnits", "strokeWidth");
    path.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    path.setAttribute("fill", "context-stroke");
    marker.append(path);
    defs.append(marker);

    return defs;
  }

  private createArrowElements(id: string): ArrowElements {
    const group = document.createElementNS(SVG_NS, "g");
    const hitLine = document.createElementNS(SVG_NS, "line");
    const line = document.createElementNS(SVG_NS, "line");

    group.classList.add("mind-map-arrow");
    group.dataset.arrowId = id;
    hitLine.classList.add("mind-map-arrow-hit");
    line.classList.add("mind-map-arrow-line");
    line.setAttribute("marker-end", `url(#${this.markerId})`);
    group.append(hitLine, line);

    group.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this.commitActiveEdit();
      this.clearTextFocusAndSelection();
      this.callbacks.onSelectionChange({
        type: "arrow",
        id,
      });
    });

    group.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.commitActiveEdit();
      this.clearTextFocusAndSelection();
      this.callbacks.onContextMenu(
        {
          type: "arrow",
          id,
        },
        event.clientX,
        event.clientY,
      );
    });

    return {
      group,
      line,
      hitLine,
    };
  }

  private syncNodeElement(element: HTMLDivElement, node: MindMapNode): void {
    const frame = this.frameOverrides.get(node.id) ?? getNodeFrame(node);
    const textElement = element.querySelector<HTMLElement>(".mind-map-node-text");

    this.applyNodeFrame(element, frame);

    if (textElement && this.activeEdit?.id !== node.id && getEditableText(textElement) !== node.text) {
      textElement.textContent = node.text;
    }
  }

  private applyNodeFrame(element: HTMLElement, frame: NodeFrame): void {
    element.style.left = `${frame.x}px`;
    element.style.top = `${frame.y}px`;
    element.style.width = `${Math.max(VISUAL_MIN_SIZE, frame.width)}px`;
    element.style.height = `${Math.max(VISUAL_MIN_SIZE, frame.height)}px`;
  }

  private updateNodeSelectionClasses(): void {
    for (const [id, element] of this.nodeElements) {
      const selected = this.selection?.type === "node" && this.selection.id === id;
      const editing = this.activeEdit?.id === id;
      const resizing =
        this.activeDrag?.nodeId === id && this.activeDrag.kind === "resize" && this.activeDrag.moved;
      const textElement = element.querySelector<HTMLElement>(".mind-map-node-text");

      element.classList.toggle("selected", selected);
      element.classList.toggle("editing", editing);
      element.classList.toggle("resizing", resizing);

      if (textElement) {
        setTextEditingEnabled(textElement, editing);
      }
    }

    for (const [id, elements] of this.arrowElements) {
      const selected = this.selection?.type === "arrow" && this.selection.id === id;

      elements.group.classList.toggle("selected", selected);
    }
  }

  private updateArrowPositions(): void {
    for (const arrow of this.data.arrows) {
      const elements = this.arrowElements.get(arrow.id);
      const fromNode = this.getNode(arrow.from.nodeId);
      const toNode = this.getNode(arrow.to.nodeId);

      if (!elements || !fromNode || !toNode) {
        continue;
      }

      const from = getEndpointPoint(this.frameOverrides.get(fromNode.id) ?? getNodeFrame(fromNode), arrow.from.side);
      const to = getEndpointPoint(this.frameOverrides.get(toNode.id) ?? getNodeFrame(toNode), arrow.to.side);

      setLinePoints(elements.line, from, to);
      setLinePoints(elements.hitLine, from, to);
    }
  }

  private updateConnectorState(): void {
    for (const [id, element] of this.nodeElements) {
      for (const connector of element.querySelectorAll<HTMLButtonElement>(".mind-map-connector")) {
        const side = connector.dataset.side as ConnectorSide | undefined;
        const pending = Boolean(
          this.pendingConnector && this.pendingConnector.nodeId === id && this.pendingConnector.side === side,
        );

        connector.classList.toggle("pending", pending);
      }
    }
  }

  private handleTextPointerDown(event: PointerEvent, id: string): void {
    if (event.button !== 0 || this.connectMode) {
      return;
    }

    event.stopPropagation();
    this.beginTextEdit(id, false);
  }

  private handleTextKeyDown(event: KeyboardEvent, id: string): void {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.commitActiveEdit();
    this.nodeElements.get(id)?.focus({
      preventScroll: true,
    });
  }

  private handleTextPaste(event: ClipboardEvent, id: string): void {
    const text = event.clipboardData?.getData("text/plain") ?? "";

    event.preventDefault();
    insertPlainText(text);
    this.updateEditingPreview(id);
  }

  private handleTextBlur(id: string): void {
    if (this.activeEdit?.id === id) {
      this.commitActiveEdit();
    }
  }

  private handleTextContextMenu(event: MouseEvent, id: string): void {
    if (this.activeEdit?.id !== id) {
      return;
    }

    event.stopPropagation();
  }

  private handleNodePointerDown(event: PointerEvent, id: string): void {
    if (event.button !== 0 || this.connectMode || this.isNodeChildControl(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.commitActiveEdit();
    this.clearTextFocusAndSelection();
    this.callbacks.onSelectionChange({
      type: "node",
      id,
    });
    this.startNodeDrag(event, id, "move");
  }

  private handleNodeContextMenu(event: MouseEvent, id: string): void {
    if (this.isEditingTextTarget(event.target, id)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.commitActiveEdit();
    this.clearTextFocusAndSelection();
    this.callbacks.onContextMenu(
      {
        type: "node",
        id,
      },
      event.clientX,
      event.clientY,
    );
  }

  private handleResizePointerDown(event: PointerEvent, id: string, handle: ResizeHandle): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.commitActiveEdit();
    this.clearTextFocusAndSelection();
    this.callbacks.onSelectionChange({
      type: "node",
      id,
    });
    this.startNodeDrag(event, id, "resize", handle);
  }

  private handleConnectorPointerDown(event: PointerEvent): void {
    if (!this.connectMode || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  private handleConnectorClick(event: MouseEvent, nodeId: string, side: ConnectorSide): void {
    if (!this.connectMode) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.commitActiveEdit();
    this.clearTextFocusAndSelection();

    const endpoint = {
      nodeId,
      side,
    };

    if (!this.pendingConnector) {
      this.pendingConnector = endpoint;
      this.callbacks.onSelectionChange({
        type: "node",
        id: nodeId,
      });
      this.updateConnectorState();
      return;
    }

    if (this.pendingConnector.nodeId === nodeId) {
      this.pendingConnector = endpoint;
      this.updateConnectorState();
      return;
    }

    const from = this.pendingConnector;
    this.pendingConnector = null;
    this.updateConnectorState();
    this.callbacks.onArrowCreate(from, endpoint);
  }

  private beginTextEdit(id: string, shouldFocus: boolean): void {
    if (this.activeEdit?.id === id) {
      if (shouldFocus) {
        this.focusTextElement(id);
      }

      return;
    }

    this.commitActiveEdit();

    const node = this.getNode(id);

    if (!node) {
      return;
    }

    this.activeEdit = {
      id,
      autoWidth: node.autoWidth,
      originalFrame: getNodeFrame(node),
      originalText: node.text,
    };
    this.callbacks.onSelectionChange({
      type: "node",
      id,
    });
    this.updateNodeSelectionClasses();

    if (shouldFocus) {
      this.focusTextElement(id);
    }
  }

  private focusTextElement(id: string): void {
    requestAnimationFrame(() => {
      const element = this.nodeElements.get(id);
      const textElement = element?.querySelector<HTMLElement>(".mind-map-node-text");

      if (!textElement) {
        return;
      }

      textElement.focus({
        preventScroll: true,
      });
      placeCaretAtEnd(textElement);
    });
  }

  private updateEditingPreview(id: string): void {
    if (this.activeEdit?.id !== id) {
      return;
    }

    const element = this.nodeElements.get(id);
    const textElement = element?.querySelector<HTMLElement>(".mind-map-node-text");
    const node = this.getNode(id);

    if (!element || !textElement || !node) {
      return;
    }

    const frame = this.textLayout.getTextFittedFrame(
      textElement,
      getEditableText(textElement),
      getNodeFrame(node),
      this.activeEdit,
    );

    this.frameOverrides.set(id, frame);
    this.applyNodeFrame(element, frame);
    this.updateArrowPositions();
  }

  private startNodeDrag(event: PointerEvent, id: string, kind: DragState["kind"], handle?: ResizeHandle): void {
    const node = this.getNode(id);
    const element = this.nodeElements.get(id);

    if (!node || !element) {
      return;
    }

    this.activeDrag = {
      kind,
      nodeId: id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startFrame: this.frameOverrides.get(id) ?? getNodeFrame(node),
      currentFrame: this.frameOverrides.get(id) ?? getNodeFrame(node),
      moved: false,
      handle,
    };
    this.clearTextFocusAndSelection();
    this.updateNodeSelectionClasses();
    this.setResizeCursor(kind === "resize" ? handle ?? null : null);
    element.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", this.handleDragPointerMove);
    window.addEventListener("pointerup", this.handleDragPointerUp);
    window.addEventListener("pointercancel", this.handleDragPointerUp);
  }

  private startPan(event: PointerEvent): void {
    this.panState = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffset: {
        ...this.offset,
      },
    };
    this.host.classList.add("panning");
    this.host.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", this.handlePanPointerMove);
    window.addEventListener("pointerup", this.handlePanPointerUp);
    window.addEventListener("pointercancel", this.handlePanPointerUp);
  }

  private removeDragListeners(): void {
    window.removeEventListener("pointermove", this.handleDragPointerMove);
    window.removeEventListener("pointerup", this.handleDragPointerUp);
    window.removeEventListener("pointercancel", this.handleDragPointerUp);
  }

  private removePanListeners(): void {
    window.removeEventListener("pointermove", this.handlePanPointerMove);
    window.removeEventListener("pointerup", this.handlePanPointerUp);
    window.removeEventListener("pointercancel", this.handlePanPointerUp);
  }

  private setResizeCursor(handle: ResizeHandle | null): void {
    for (const resizeHandle of RESIZE_HANDLES) {
      this.host.classList.toggle(`resize-cursor-${resizeHandle}`, handle === resizeHandle);
    }
  }

  private applyViewportTransform(): void {
    this.viewport.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.scale})`;

    const gridSize = GRID_SIZE * this.scale;
    const backgroundX = modulo(this.offset.x, gridSize);
    const backgroundY = modulo(this.offset.y, gridSize);

    this.host.style.backgroundSize = `${gridSize}px ${gridSize}px`;
    this.host.style.backgroundPosition = `${backgroundX}px ${backgroundY}px`;
  }

  private screenToWorld(clientX: number, clientY: number): Point {
    const rect = this.host.getBoundingClientRect();

    return {
      x: (clientX - rect.left - this.offset.x) / this.scale,
      y: (clientY - rect.top - this.offset.y) / this.scale,
    };
  }

  private getNodesBounds(nodes: MindMapNode[]): NodeFrame {
    const left = Math.min(...nodes.map((node) => node.x));
    const top = Math.min(...nodes.map((node) => node.y));
    const right = Math.max(...nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));

    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  private getNode(id: string): MindMapNode | null {
    return this.data.nodes.find((node) => node.id === id) ?? null;
  }

  private isBlankTarget(target: EventTarget | null): boolean {
    return (
      target === this.host ||
      target === this.viewport ||
      target === this.arrowSvg ||
      target === this.nodeLayer
    );
  }

  private isNodeChildControl(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(".mind-map-node-text, .mind-map-handle, .mind-map-connector"));
  }

  private isEditingTextTarget(target: EventTarget | null, id: string): boolean {
    return (
      this.activeEdit?.id === id &&
      target instanceof Element &&
      Boolean(target.closest(".mind-map-node-text"))
    );
  }

  private clearTextFocusAndSelection(): void {
    const activeElement = document.activeElement;

    if (
      activeElement instanceof HTMLElement &&
      this.host.contains(activeElement) &&
      Boolean(activeElement.closest(".mind-map-node-text"))
    ) {
      activeElement.blur();
    }

    window.getSelection()?.removeAllRanges();
  }
}

function setLinePoints(line: SVGLineElement, from: Point, to: Point): void {
  line.setAttribute("x1", String(from.x));
  line.setAttribute("y1", String(from.y));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y));
}

function getEditableText(element: HTMLElement): string {
  return element.textContent ?? "";
}

function setTextEditingEnabled(element: HTMLElement, enabled: boolean): void {
  element.setAttribute("contenteditable", enabled ? "plaintext-only" : "false");
  element.setAttribute("aria-readonly", String(!enabled));
}

function insertPlainText(text: string): void {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return;
  }

  selection.deleteFromDocument();
  const range = selection.getRangeAt(0);
  const textNode = document.createTextNode(text);

  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  const range = document.createRange();

  range.selectNodeContents(element);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function releasePointerCapture(element: Element, pointerId: number): void {
  if (element.hasPointerCapture(pointerId)) {
    element.releasePointerCapture(pointerId);
  }
}
