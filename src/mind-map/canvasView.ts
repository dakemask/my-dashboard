import Konva from "konva";
import { DEFAULT_NODE_HEIGHT, DEFAULT_NODE_WIDTH, MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from "./mindMap";
import {
  ARROW_NAME,
  CONNECTOR_NAME,
  CONNECTOR_SIDES,
  MOVE_THRESHOLD,
  NODE_NAME,
  NODE_TEXT_HIT_NAME,
  NODE_TEXT_NAME,
} from "./canvasConstants";
import {
  applyGroupSize,
  applyNodeSelectionStyle,
  createNodeShape,
  findNamedNode,
  getClientPointFromEvent,
  isConnectorSide,
} from "./canvasShapes";
import {
  getWorldPointerPosition,
  resetStageView,
  screenToWorld,
  updateGrid,
  zoomStageWithWheel,
} from "./canvasViewport";
import { TextEditorOverlay, type EditTextPointerOptions, type TextEditSession } from "./textEditorOverlay";
import {
  fitNewNodeFrameToText,
  fitNodeFrameHeightToText,
  getCanvasTextFont,
  getTextIndexAtPoint,
  TEXT_FONT_FAMILY,
  TEXT_FONT_SIZE,
  TEXT_LINE_HEIGHT,
  TEXT_PADDING,
} from "./textLayout";
import type { MindMapData, MindMapEndpoint, MindMapSelection, NodeFrame } from "./types";

interface CanvasCallbacks {
  onSelectionChange: (selection: MindMapSelection) => void;
  onNodeFrameChange: (id: string, frame: NodeFrame) => void;
  onNodeTextChange: (id: string, text: string) => void;
  onArrowCreate: (from: MindMapEndpoint, to: MindMapEndpoint) => void;
  onContextMenu: (selection: MindMapSelection, x: number, y: number) => void;
}

type EditNodeTextOptions = EditTextPointerOptions;

interface NodeMoveSession {
  id: string;
  group: Konva.Group;
  startPointer: {
    x: number;
    y: number;
  };
  startFrame: NodeFrame;
  moved: boolean;
}

export class MindMapCanvas {
  private readonly stage: Konva.Stage;
  private readonly arrowLayer = new Konva.Layer();
  private readonly nodeLayer = new Konva.Layer();
  private readonly connectorLayer = new Konva.Layer();
  private readonly uiLayer = new Konva.Layer();
  private readonly transformer: Konva.Transformer;
  private readonly textEditor: TextEditorOverlay;
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
  private movingNode: NodeMoveSession | null = null;
  private isPanning = false;
  private lastPanPoint: { x: number; y: number } | null = null;
  private readonly handleWheel = (event: WheelEvent): void => this.zoomWithWheel(event);
  private readonly handleDomContextMenu = (event: MouseEvent): void => this.openContextMenuFromDom(event);
  private readonly handleDomDoubleClick = (event: MouseEvent): void => this.editNodeFromDom(event);
  private readonly handlePointerLeave = (): void => this.stopPanning();

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
      borderStroke: "rgba(37, 99, 235, 0.74)",
      anchorStroke: "rgba(37, 99, 235, 0.8)",
      anchorFill: "#ffffff",
      anchorSize: 7,
      anchorStrokeWidth: 1,
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
    this.textEditor = new TextEditorOverlay({
      onPreview: (session) => this.previewEditorText(session),
      onPosition: (session) => this.positionTextEditor(session),
      onClose: (session, commit) => this.finishTextEdit(session, commit),
      getTextIndexAtClientPoint: (session, clientPoint) =>
        this.getEditorTextIndexFromClientPoint(session, clientPoint),
    });

    this.uiLayer.add(this.transformer);
    this.stage.add(this.arrowLayer, this.nodeLayer, this.connectorLayer, this.uiLayer);
    this.stage.on("click tap", (event) => this.handleStageClick(event));
    this.stage.on("mousedown touchstart", (event) => this.startPanning(event));
    this.stage.on("mousemove touchmove", () => this.handlePointerMove());
    this.stage.on("mouseup touchend", (event) => this.handlePointerUp(event.target));
    this.host.addEventListener("wheel", this.handleWheel, {
      passive: false,
    });
    this.host.addEventListener("contextmenu", this.handleDomContextMenu);
    this.host.addEventListener("dblclick", this.handleDomDoubleClick);
    this.host.addEventListener("mouseleave", this.handlePointerLeave);

    this.resizeObserver = new ResizeObserver(() => this.resizeStage());
    this.resizeObserver.observe(host);
    updateGrid(this.host, this.stage);
    requestAnimationFrame(() => this.resizeStage(true));
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

    if (this.connectMode && !this.textEditor.activeId) {
      this.createConnectorHandles();
    }

    this.updateTransformer();
    this.stage.container().classList.toggle("connect-mode", this.connectMode);
    this.stage.batchDraw();
  }

  setConnectMode(enabled: boolean): void {
    this.closeActiveEditor(true);
    this.connectMode = enabled;
    this.stage.container().style.cursor = enabled ? "crosshair" : "default";
    this.cancelPendingConnection();
    this.render(this.data, this.selection);
  }

  getNewNodePosition(): { x: number; y: number } {
    const center = screenToWorld(this.stage, {
      x: this.stage.width() / 2,
      y: this.stage.height() / 2,
    });

    return {
      x: Math.round(center.x - 130),
      y: Math.round(center.y - 46),
    };
  }

  resetView(): void {
    this.closeActiveEditor(true);
    resetStageView(this.stage, this.host, this.data.nodes);
  }

  commitActiveEdit(): void {
    this.closeActiveEditor(true);
  }

  editNodeText(id: string, options: EditNodeTextOptions = {}): void {
    if (this.textEditor.activeId === id) {
      this.textEditor.focus(options);
      return;
    }

    this.closeActiveEditor(true);
    this.cancelPendingConnection();

    const node = this.data.nodes.find((item) => item.id === id);
    const group = this.nodeGroups.get(id);

    if (!node || !group) {
      return;
    }

    this.selection = {
      type: "node",
      id,
    };
    this.nodeGroups.forEach((nodeGroup, nodeId) => applyNodeSelectionStyle(nodeGroup, nodeId === id));

    const textNode = group.findOne(`.${NODE_TEXT_NAME}`);
    const typedTextNode = textNode instanceof Konva.Text ? textNode : null;
    this.updateTransformer();
    this.nodeLayer.draw();

    this.textEditor.open({
      id,
      text: node.text,
      group,
      textNode: typedTextNode,
      originalFrame: this.readGroupFrame(group),
      autoWidthOnInput:
        node.text.trim().length === 0 &&
        node.width === DEFAULT_NODE_WIDTH &&
        node.height === DEFAULT_NODE_HEIGHT,
      selectAllWhenEmpty: !node.text,
      ...options,
    });
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.host.removeEventListener("wheel", this.handleWheel);
    this.host.removeEventListener("contextmenu", this.handleDomContextMenu);
    this.host.removeEventListener("dblclick", this.handleDomDoubleClick);
    this.host.removeEventListener("mouseleave", this.handlePointerLeave);
    this.closeActiveEditor(false);
    this.stage.destroy();
  }

  private createNodeGroup(node: NodeFrame & { id: string; text: string }): void {
    const selected = this.selection?.type === "node" && this.selection.id === node.id;
    const { group, textHit, moveHits } = createNodeShape(node, selected);

    textHit.on("mousedown touchstart", (event) => {
      if (this.connectMode || this.pendingConnection) {
        return;
      }

      event.cancelBubble = true;

      const clientPoint = getClientPointFromEvent(event.evt);
      if (!clientPoint) {
        return;
      }

      if (event.evt instanceof MouseEvent) {
        if (event.evt.button !== 0) {
          return;
        }

        event.evt.preventDefault();
      }

      this.editNodeText(node.id, {
        caretClientPoint: clientPoint,
        dragSelect: event.evt instanceof MouseEvent,
      });
    });
    textHit.on("mouseenter", () => {
      if (!this.connectMode) {
        this.stage.container().style.cursor = "text";
      }
    });
    textHit.on("mouseleave", () => {
      this.stage.container().style.cursor = this.connectMode ? "crosshair" : "default";
    });

    moveHits.forEach((hit) => {
      hit.on("mousedown touchstart", (event) => {
        if (this.connectMode || this.pendingConnection) {
          return;
        }

        event.cancelBubble = true;
        this.startNodeMove(node.id, group);
      });
      hit.on("click tap", (event) => {
        if (this.pendingConnection) {
          return;
        }

        event.cancelBubble = true;
        this.callbacks.onSelectionChange({
          type: "node",
          id: node.id,
        });
      });
      hit.on("mouseenter", () => {
        if (!this.connectMode) {
          this.stage.container().style.cursor = "move";
        }
      });
      hit.on("mouseleave", () => {
        this.stage.container().style.cursor = this.connectMode ? "crosshair" : "default";
      });
    });

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
          radius: 3,
          fill: "#8b8b86",
          stroke: "#8b8b86",
          strokeWidth: 1,
          hitStrokeWidth: 12,
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
    applyGroupSize(group, width, height);
    this.syncConnectionsFromShapes();
    this.transformer.forceUpdate();
  }

  private startNodeMove(id: string, group: Konva.Group): void {
    this.closeActiveEditor(true);
    const liveGroup = this.nodeGroups.get(id) ?? group;

    const pointer = getWorldPointerPosition(this.stage);

    if (!pointer) {
      return;
    }

    this.movingNode = {
      id,
      group: liveGroup,
      startPointer: pointer,
      startFrame: this.readGroupFrame(liveGroup),
      moved: false,
    };
    this.stage.container().style.cursor = "move";
  }

  private updateNodeMove(): void {
    if (!this.movingNode) {
      return;
    }

    const pointer = getWorldPointerPosition(this.stage);

    if (!pointer) {
      return;
    }

    const dx = pointer.x - this.movingNode.startPointer.x;
    const dy = pointer.y - this.movingNode.startPointer.y;

    if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) {
      this.movingNode.moved = true;
    }

    this.movingNode.group.position({
      x: this.movingNode.startFrame.x + dx,
      y: this.movingNode.startFrame.y + dy,
    });
    this.syncConnectionsFromShapes();
  }

  private finishNodeMove(): void {
    if (!this.movingNode) {
      return;
    }

    const move = this.movingNode;
    this.movingNode = null;
    this.stage.container().style.cursor = this.connectMode ? "crosshair" : "default";

    if (move.moved) {
      this.callbacks.onNodeFrameChange(move.id, this.readGroupFrame(move.group));
    }
  }

  private previewEditorText(session: TextEditSession): void {
    session.textNode?.text(session.textarea.value);
    const frame = this.getEditorPreviewFrame(session);
    applyGroupSize(session.group, frame.width, frame.height);
    this.transformer.forceUpdate();
    this.positionTextEditor(session);
    this.syncConnectionsFromShapes();
  }

  private finishTextEdit(session: TextEditSession, commit: boolean): void {
    if (commit) {
      session.textNode?.text(session.textarea.value);
    } else {
      session.textNode?.text(session.originalText);
      applyGroupSize(session.group, session.originalFrame.width, session.originalFrame.height);
    }

    this.updateTransformer();
    this.nodeLayer.draw();

    if (commit) {
      this.callbacks.onNodeTextChange(session.id, session.textarea.value);
      this.callbacks.onSelectionChange({
        type: "node",
        id: session.id,
      });
    }
  }

  private getEditorPreviewFrame(session: TextEditSession): NodeFrame {
    const frame = {
      ...this.readGroupFrame(session.group),
      x: session.originalFrame.x,
      y: session.originalFrame.y,
    };

    return session.autoWidthOnInput
      ? fitNewNodeFrameToText(frame, session.textarea.value)
      : fitNodeFrameHeightToText(frame, session.textarea.value);
  }

  private positionTextEditor(session: TextEditSession): void {
    const stageBox = this.stage.container().getBoundingClientRect();
    const scale = this.stage.scaleX();
    const stagePosition = this.stage.position();
    const frame = this.readGroupFrame(session.group);
    const textarea = session.textarea;
    const textWidth = Math.max(1, frame.width - TEXT_PADDING * 2);
    const textHeight = Math.max(1, frame.height - TEXT_PADDING * 2);

    textarea.style.left = `${stageBox.left + stagePosition.x + (frame.x + TEXT_PADDING) * scale}px`;
    textarea.style.top = `${stageBox.top + stagePosition.y + (frame.y + TEXT_PADDING) * scale}px`;
    textarea.style.width = `${textWidth * scale}px`;
    textarea.style.height = `${textHeight * scale}px`;
    textarea.style.padding = "0";
    textarea.style.font = getCanvasTextFont(scale);
    textarea.style.fontFamily = TEXT_FONT_FAMILY;
    textarea.style.fontSize = `${TEXT_FONT_SIZE * scale}px`;
    textarea.style.lineHeight = String(TEXT_LINE_HEIGHT);
  }

  private getEditorTextIndexFromClientPoint(
    session: TextEditSession,
    clientPoint: { x: number; y: number },
  ): number {
    const stageBox = this.stage.container().getBoundingClientRect();
    const scale = this.stage.scaleX();
    const stagePosition = this.stage.position();
    const frame = this.readGroupFrame(session.group);
    const worldPoint = {
      x: (clientPoint.x - stageBox.left - stagePosition.x) / scale,
      y: (clientPoint.y - stageBox.top - stagePosition.y) / scale,
    };

    return getTextIndexAtPoint(session.textarea.value, frame.width, {
      x: worldPoint.x - frame.x - TEXT_PADDING,
      y: worldPoint.y - frame.y - TEXT_PADDING,
    });
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
    const pointer = getWorldPointerPosition(this.stage);

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

    if (this.textEditor.consumeSuppressedStageClick()) {
      return;
    }

    this.closeActiveEditor(true);
    this.callbacks.onSelectionChange(null);
  }

  private startPanning(event: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void {
    if (this.connectMode || this.pendingConnection || this.movingNode || event.target !== this.stage) {
      return;
    }

    if (event.evt instanceof MouseEvent && event.evt.button !== 0) {
      return;
    }

    const pointer = this.stage.getPointerPosition();

    if (!pointer) {
      return;
    }

    this.isPanning = true;
    this.lastPanPoint = pointer;
    this.stage.container().style.cursor = "grabbing";
  }

  private handlePointerMove(): void {
    this.updateNodeMove();

    if (this.isPanning) {
      const pointer = this.stage.getPointerPosition();

      if (pointer && this.lastPanPoint) {
        this.stage.position({
          x: this.stage.x() + pointer.x - this.lastPanPoint.x,
          y: this.stage.y() + pointer.y - this.lastPanPoint.y,
        });
        this.lastPanPoint = pointer;
        updateGrid(this.host, this.stage);
        this.stage.batchDraw();
      }
    }

    this.updateConnectionPreview();
  }

  private handlePointerUp(target: Konva.Node): void {
    this.stopPanning();
    this.finishNodeMove();
    this.finishConnection(target);
  }

  private stopPanning(): void {
    if (!this.isPanning) {
      return;
    }

    this.isPanning = false;
    this.lastPanPoint = null;
    this.stage.container().style.cursor = this.connectMode ? "crosshair" : "default";
  }

  private zoomWithWheel(event: WheelEvent): void {
    this.closeActiveEditor(true);
    zoomStageWithWheel(this.stage, this.host, event);
  }

  private openContextMenuFromDom(event: MouseEvent): void {
    event.preventDefault();
    this.closeActiveEditor(true);
    this.stage.setPointersPositions(event);

    const pointer = this.stage.getPointerPosition();
    const target = pointer ? this.stage.getIntersection(pointer) : null;
    const selection = target ? this.getSelectionFromTarget(target) : null;

    if (!selection) {
      this.callbacks.onSelectionChange(null);
      return;
    }

    this.callbacks.onSelectionChange(selection);
    this.callbacks.onContextMenu(selection, event.clientX, event.clientY);
  }

  private editNodeFromDom(event: MouseEvent): void {
    if (this.connectMode) {
      return;
    }

    this.stage.setPointersPositions(event);

    const pointer = this.stage.getPointerPosition();
    const target = pointer ? this.stage.getIntersection(pointer) : null;
    const selection = target ? this.getSelectionFromTarget(target) : null;

    if (selection?.type !== "node" || !target || !findNamedNode(target, NODE_TEXT_HIT_NAME)) {
      return;
    }

    event.preventDefault();
    this.callbacks.onSelectionChange(selection);
    this.editNodeText(selection.id);
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

  private resizeStage(force = false): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;

    if (!force && width === this.stage.width() && height === this.stage.height()) {
      return;
    }

    this.stage.width(width);
    this.stage.height(height);
    updateGrid(this.host, this.stage);
    this.textEditor.positionActive();
    this.stage.batchDraw();
  }

  private closeActiveEditor(commit: boolean): void {
    this.textEditor.close(commit);
  }
}
