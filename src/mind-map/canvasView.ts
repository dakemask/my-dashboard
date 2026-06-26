import Konva from "konva";
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from "./mindMap";
import {
  getCanvasTextFont,
  TEXT_FONT_FAMILY,
  TEXT_FONT_SIZE,
  TEXT_LINE_HEIGHT,
  TEXT_PADDING,
} from "./textLayout";
import type {
  ConnectorSide,
  MindMapData,
  MindMapEndpoint,
  MindMapSelection,
  NodeFrame,
} from "./types";

interface CanvasCallbacks {
  onSelectionChange: (selection: MindMapSelection) => void;
  onNodeFrameChange: (id: string, frame: NodeFrame) => void;
  onNodeTextChange: (id: string, text: string) => void;
  onArrowCreate: (from: MindMapEndpoint, to: MindMapEndpoint) => void;
  onContextMenu: (selection: MindMapSelection, x: number, y: number) => void;
}

const NODE_NAME = "mind-node";
const NODE_RECT_NAME = "node-rect";
const NODE_TEXT_NAME = "node-text";
const ARROW_NAME = "mind-arrow";
const CONNECTOR_NAME = "connector-handle";
const CONNECTOR_SIDES: ConnectorSide[] = ["top", "right", "bottom", "left"];

export class MindMapCanvas {
  private readonly stage: Konva.Stage;
  private readonly arrowLayer = new Konva.Layer();
  private readonly nodeLayer = new Konva.Layer();
  private readonly connectorLayer = new Konva.Layer();
  private readonly uiLayer = new Konva.Layer();
  private readonly transformer: Konva.Transformer;
  private readonly resizeObserver: ResizeObserver;
  private readonly nodeGroups = new Map<string, Konva.Group>();
  private readonly arrowShapes = new Map<string, Konva.Arrow>();
  private data: MindMapData = {
    nodes: [],
    arrows: [],
  };
  private selection: MindMapSelection = null;
  private connectMode = false;
  private pendingConnection: MindMapEndpoint | null = null;
  private previewArrow: Konva.Arrow | null = null;
  private activeEditor: HTMLTextAreaElement | null = null;
  private activeEditorClose: ((commit: boolean) => void) | null = null;

  constructor(
    private readonly host: HTMLDivElement,
    private readonly callbacks: CanvasCallbacks,
  ) {
    this.stage = new Konva.Stage({
      container: host,
      width: host.clientWidth,
      height: host.clientHeight,
    });
    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      keepRatio: false,
      ignoreStroke: true,
      borderStroke: "#2563eb",
      anchorStroke: "#2563eb",
      anchorFill: "#ffffff",
      anchorSize: 9,
      enabledAnchors: [
        "top-left",
        "top-center",
        "top-right",
        "middle-left",
        "middle-right",
        "bottom-left",
        "bottom-center",
        "bottom-right",
      ],
      boundBoxFunc: (oldBox, newBox) =>
        newBox.width < MIN_NODE_WIDTH || newBox.height < MIN_NODE_HEIGHT ? oldBox : newBox,
    });

    this.uiLayer.add(this.transformer);
    this.stage.add(this.arrowLayer, this.nodeLayer, this.connectorLayer, this.uiLayer);
    this.stage.on("click tap", (event) => this.handleStageClick(event));
    this.stage.on("contextmenu", (event) => this.handleContextMenu(event));
    this.stage.on("mousemove touchmove", () => this.updateConnectionPreview());
    this.stage.on("mouseup touchend", (event) => this.finishConnection(event.target));

    this.resizeObserver = new ResizeObserver(() => this.resizeStage());
    this.resizeObserver.observe(host);
  }

  render(data: MindMapData, selection: MindMapSelection): void {
    this.data = data;
    this.selection = selection;
    this.nodeGroups.clear();
    this.arrowShapes.clear();
    this.arrowLayer.destroyChildren();
    this.nodeLayer.destroyChildren();
    this.connectorLayer.destroyChildren();
    this.data.arrows.forEach((arrow) => this.createArrow(arrow.id, arrow.from, arrow.to));
    this.data.nodes.forEach((node) => this.createNodeGroup(node));

    if (this.connectMode) {
      this.createConnectorHandles();
    }

    this.updateTransformer();
    this.stage.container().classList.toggle("connect-mode", this.connectMode);
    this.stage.batchDraw();
  }

  setConnectMode(enabled: boolean): void {
    this.connectMode = enabled;
    this.stage.container().style.cursor = enabled ? "crosshair" : "default";
    this.cancelPendingConnection();
    this.render(this.data, this.selection);
  }

  getNewNodePosition(): { x: number; y: number } {
    return {
      x: Math.round(this.stage.width() / 2 - 130),
      y: Math.round(this.stage.height() / 2 - 46),
    };
  }

  editNodeText(id: string): void {
    const node = this.data.nodes.find((item) => item.id === id);
    const group = this.nodeGroups.get(id);

    if (!node || !group) {
      return;
    }

    this.closeActiveEditor(false);

    const textNode = group.findOne(`.${NODE_TEXT_NAME}`);
    textNode?.hide();
    this.nodeLayer.draw();

    const stageBox = this.stage.container().getBoundingClientRect();
    const textarea = document.createElement("textarea");
    textarea.className = "node-text-editor";
    textarea.value = node.text;
    textarea.style.left = `${stageBox.left + group.x() + TEXT_PADDING}px`;
    textarea.style.top = `${stageBox.top + group.y() + TEXT_PADDING}px`;
    textarea.style.width = `${Math.max(40, group.width() - TEXT_PADDING * 2)}px`;
    textarea.style.height = `${Math.max(36, group.height() - TEXT_PADDING * 2)}px`;
    textarea.style.font = getCanvasTextFont();
    textarea.style.lineHeight = String(TEXT_LINE_HEIGHT);
    document.body.append(textarea);
    this.activeEditor = textarea;

    let closed = false;
    const finish = (commit: boolean): void => {
      if (closed) {
        return;
      }

      closed = true;
      textarea.removeEventListener("blur", commitOnBlur);
      textarea.remove();
      this.activeEditor = null;
      this.activeEditorClose = null;
      textNode?.show();
      this.nodeLayer.draw();

      if (commit && textarea.value !== node.text) {
        this.callbacks.onNodeTextChange(id, textarea.value);
      }
    };
    const commitOnBlur = (): void => finish(true);
    this.activeEditorClose = finish;

    textarea.addEventListener("blur", commitOnBlur);
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
        return;
      }

      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
      }
    });

    requestAnimationFrame(() => {
      textarea.focus();
      if (!node.text) {
        textarea.select();
      }
    });
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.closeActiveEditor(false);
    this.stage.destroy();
  }

  private createNodeGroup(node: NodeFrame & { id: string; text: string }): void {
    const selected = this.selection?.type === "node" && this.selection.id === node.id;
    const group = new Konva.Group({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      draggable: !this.connectMode,
      name: NODE_NAME,
    });
    group.setAttr("nodeId", node.id);

    const rect = new Konva.Rect({
      width: node.width,
      height: node.height,
      fill: "#ffffff",
      stroke: selected ? "#2563eb" : "#111827",
      strokeWidth: selected ? 2 : 1,
      cornerRadius: 0,
      name: NODE_RECT_NAME,
      shadowColor: selected ? "rgba(37, 99, 235, 0.18)" : "transparent",
      shadowBlur: selected ? 10 : 0,
    });
    const text = new Konva.Text({
      x: TEXT_PADDING,
      y: TEXT_PADDING,
      width: Math.max(1, node.width - TEXT_PADDING * 2),
      height: Math.max(1, node.height - TEXT_PADDING * 2),
      text: node.text,
      fontFamily: TEXT_FONT_FAMILY,
      fontSize: TEXT_FONT_SIZE,
      lineHeight: TEXT_LINE_HEIGHT,
      fill: "#111827",
      wrap: "char",
      listening: false,
      name: NODE_TEXT_NAME,
    });

    group.add(rect, text);
    group.on("click tap", (event) => {
      if (this.pendingConnection) {
        return;
      }

      event.cancelBubble = true;
      this.callbacks.onSelectionChange({
        type: "node",
        id: node.id,
      });
    });
    group.on("dblclick dbltap", (event) => {
      if (this.connectMode) {
        return;
      }

      event.cancelBubble = true;
      this.callbacks.onSelectionChange({
        type: "node",
        id: node.id,
      });
      this.editNodeText(node.id);
    });
    group.on("dragmove", () => this.syncConnectionsFromShapes());
    group.on("dragend", () => this.callbacks.onNodeFrameChange(node.id, this.readGroupFrame(group)));
    group.on("transform", () => this.handleNodeTransform(group));
    group.on("transformend", () => this.callbacks.onNodeFrameChange(node.id, this.readGroupFrame(group)));

    this.nodeGroups.set(node.id, group);
    this.nodeLayer.add(group);
  }

  private createArrow(id: string, from: MindMapEndpoint, to: MindMapEndpoint): void {
    const start = this.getConnectorPoint(from);
    const end = this.getConnectorPoint(to);

    if (!start || !end) {
      return;
    }

    const selected = this.selection?.type === "arrow" && this.selection.id === id;
    const arrow = new Konva.Arrow({
      points: [start.x, start.y, end.x, end.y],
      stroke: selected ? "#1d4ed8" : "#4f76dc",
      fill: selected ? "#1d4ed8" : "#4f76dc",
      strokeWidth: selected ? 2.4 : 1.2,
      pointerLength: 10,
      pointerWidth: 8,
      hitStrokeWidth: 18,
      lineCap: "round",
      lineJoin: "round",
      name: ARROW_NAME,
    });
    arrow.setAttr("arrowId", id);
    arrow.on("click tap", (event) => {
      event.cancelBubble = true;
      this.callbacks.onSelectionChange({
        type: "arrow",
        id,
      });
    });

    this.arrowShapes.set(id, arrow);
    this.arrowLayer.add(arrow);
  }

  private createConnectorHandles(): void {
    this.data.nodes.forEach((node) => {
      CONNECTOR_SIDES.forEach((side) => {
        const point = this.getConnectorPoint({
          nodeId: node.id,
          side,
        });

        if (!point) {
          return;
        }

        const handle = new Konva.Circle({
          x: point.x,
          y: point.y,
          radius: 7,
          fill: "#ffffff",
          stroke: "#2563eb",
          strokeWidth: 2,
          hitStrokeWidth: 14,
          name: CONNECTOR_NAME,
        });
        handle.setAttr("nodeId", node.id);
        handle.setAttr("side", side);
        handle.on("mousedown touchstart", (event) => {
          event.cancelBubble = true;
          this.startConnection({
            nodeId: node.id,
            side,
          });
        });
        handle.on("mouseenter", () => {
          this.stage.container().style.cursor = "crosshair";
        });
        handle.on("mouseleave", () => {
          this.stage.container().style.cursor = this.connectMode ? "crosshair" : "default";
        });

        this.connectorLayer.add(handle);
      });
    });
  }

  private handleNodeTransform(group: Konva.Group): void {
    const width = Math.max(MIN_NODE_WIDTH, group.width() * group.scaleX());
    const height = Math.max(MIN_NODE_HEIGHT, group.height() * group.scaleY());
    group.scale({
      x: 1,
      y: 1,
    });
    this.applyGroupSize(group, width, height);
    this.syncConnectionsFromShapes();
    this.transformer.forceUpdate();
  }

  private applyGroupSize(group: Konva.Group, width: number, height: number): void {
    group.width(width);
    group.height(height);

    const rect = group.findOne(`.${NODE_RECT_NAME}`);
    const text = group.findOne(`.${NODE_TEXT_NAME}`);

    if (rect instanceof Konva.Rect) {
      rect.width(width);
      rect.height(height);
    }

    if (text instanceof Konva.Text) {
      text.width(Math.max(1, width - TEXT_PADDING * 2));
      text.height(Math.max(1, height - TEXT_PADDING * 2));
    }
  }

  private startConnection(endpoint: MindMapEndpoint): void {
    const start = this.getConnectorPoint(endpoint);

    if (!start) {
      return;
    }

    this.pendingConnection = endpoint;
    this.previewArrow?.destroy();
    this.previewArrow = new Konva.Arrow({
      points: [start.x, start.y, start.x, start.y],
      stroke: "#2563eb",
      fill: "#2563eb",
      strokeWidth: 1.4,
      pointerLength: 10,
      pointerWidth: 8,
      dash: [5, 5],
      listening: false,
    });
    this.connectorLayer.add(this.previewArrow);
    this.connectorLayer.batchDraw();
  }

  private updateConnectionPreview(): void {
    if (!this.pendingConnection || !this.previewArrow) {
      return;
    }

    const start = this.getConnectorPoint(this.pendingConnection);
    const pointer = this.stage.getPointerPosition();

    if (!start || !pointer) {
      return;
    }

    this.previewArrow.points([start.x, start.y, pointer.x, pointer.y]);
    this.connectorLayer.batchDraw();
  }

  private finishConnection(target: Konva.Node): void {
    if (!this.pendingConnection) {
      return;
    }

    const from = this.pendingConnection;
    const to = this.getEndpointFromConnector(target);
    this.cancelPendingConnection();

    if (!to || from.nodeId === to.nodeId) {
      return;
    }

    this.callbacks.onArrowCreate(from, to);
  }

  private cancelPendingConnection(): void {
    this.pendingConnection = null;
    this.previewArrow?.destroy();
    this.previewArrow = null;
    this.connectorLayer.batchDraw();
  }

  private syncConnectionsFromShapes(): void {
    this.data.arrows.forEach((arrow) => {
      const shape = this.arrowShapes.get(arrow.id);
      const start = this.getConnectorPoint(arrow.from);
      const end = this.getConnectorPoint(arrow.to);

      if (shape && start && end) {
        shape.points([start.x, start.y, end.x, end.y]);
      }
    });

    this.connectorLayer.find(`.${CONNECTOR_NAME}`).forEach((node) => {
      const endpoint = this.getEndpointFromConnector(node);
      const point = endpoint ? this.getConnectorPoint(endpoint) : null;

      if (point) {
        node.position(point);
      }
    });

    this.stage.batchDraw();
  }

  private updateTransformer(): void {
    if (this.selection?.type !== "node") {
      this.transformer.nodes([]);
      this.uiLayer.batchDraw();
      return;
    }

    const group = this.nodeGroups.get(this.selection.id);
    this.transformer.nodes(group ? [group] : []);
    this.uiLayer.batchDraw();
  }

  private handleStageClick(event: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void {
    if (this.pendingConnection || event.target !== this.stage) {
      return;
    }

    this.callbacks.onSelectionChange(null);
  }

  private handleContextMenu(event: Konva.KonvaEventObject<PointerEvent>): void {
    event.evt.preventDefault();

    const selection = this.getSelectionFromTarget(event.target);
    if (!selection) {
      this.callbacks.onSelectionChange(null);
      return;
    }

    event.cancelBubble = true;
    this.callbacks.onSelectionChange(selection);
    this.callbacks.onContextMenu(selection, event.evt.clientX, event.evt.clientY);
  }

  private getSelectionFromTarget(target: Konva.Node): MindMapSelection {
    const arrow = findNamedNode(target, ARROW_NAME);
    if (arrow) {
      const arrowId = arrow.getAttr("arrowId");
      return typeof arrowId === "string"
        ? {
            type: "arrow",
            id: arrowId,
          }
        : null;
    }

    const group = findNamedNode(target, NODE_NAME);
    if (!group) {
      return null;
    }

    const nodeId = group.getAttr("nodeId");
    return typeof nodeId === "string"
      ? {
          type: "node",
          id: nodeId,
        }
      : null;
  }

  private getEndpointFromConnector(target: Konva.Node): MindMapEndpoint | null {
    const handle = findNamedNode(target, CONNECTOR_NAME);
    if (!handle) {
      return null;
    }

    const nodeId = handle.getAttr("nodeId");
    const side = handle.getAttr("side");

    if (typeof nodeId !== "string" || !isConnectorSide(side)) {
      return null;
    }

    return {
      nodeId,
      side,
    };
  }

  private getConnectorPoint(endpoint: MindMapEndpoint): { x: number; y: number } | null {
    const frame = this.readLiveNodeFrame(endpoint.nodeId);

    if (!frame) {
      return null;
    }

    switch (endpoint.side) {
      case "top":
        return {
          x: frame.x + frame.width / 2,
          y: frame.y,
        };
      case "right":
        return {
          x: frame.x + frame.width,
          y: frame.y + frame.height / 2,
        };
      case "bottom":
        return {
          x: frame.x + frame.width / 2,
          y: frame.y + frame.height,
        };
      case "left":
        return {
          x: frame.x,
          y: frame.y + frame.height / 2,
        };
    }
  }

  private readLiveNodeFrame(id: string): NodeFrame | null {
    const group = this.nodeGroups.get(id);
    if (group) {
      return this.readGroupFrame(group);
    }

    const node = this.data.nodes.find((item) => item.id === id);
    return node
      ? {
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
        }
      : null;
  }

  private readGroupFrame(group: Konva.Group): NodeFrame {
    return {
      x: Math.round(group.x()),
      y: Math.round(group.y()),
      width: Math.round(group.width()),
      height: Math.round(group.height()),
    };
  }

  private resizeStage(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    if (width === this.stage.width() && height === this.stage.height()) {
      return;
    }

    this.stage.width(width);
    this.stage.height(height);
    this.stage.batchDraw();
  }

  private closeActiveEditor(commit: boolean): void {
    if (!this.activeEditor && !this.activeEditorClose) {
      return;
    }

    if (this.activeEditorClose) {
      this.activeEditorClose(commit);
      return;
    }

    this.activeEditor?.remove();
    this.activeEditor = null;
  }
}

function findNamedNode(target: Konva.Node, name: string): Konva.Node | null {
  let current: Konva.Node | null = target;

  while (current) {
    if (current.hasName(name)) {
      return current;
    }

    current = current.getParent();
  }

  return null;
}

function isConnectorSide(value: unknown): value is ConnectorSide {
  return CONNECTOR_SIDES.some((side) => side === value);
}
