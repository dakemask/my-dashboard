import type {
  ConnectorSide,
  MindMapDocument,
  MindMapEndpoint,
  MindMapNode,
  NodeFrame,
} from "../domain";
import { EdgeAutoPan, type AnimationFrameScheduler } from "./autoPan";
import {
  arrowLine,
  connectorMidpoint,
  nodeFrame,
  normalizeRect,
  rectFullyContainsLine,
  rectFullyContainsRect,
  resizeFrameFromSouthEast,
  squaredDistance,
  translateFrame,
  type Point,
  type Rect,
} from "./geometry";
import {
  IDENTITY_VIEWPORT,
  clientToWorld,
  fitFramesInViewport,
  normalizeViewport,
  panViewport,
  visibleCanvasRect,
  wheelZoomScale,
  worldToClient,
  zoomAtClientPoint,
  type CanvasViewport,
  type ClientRectLike,
} from "./viewport";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const CONNECTOR_SIDES: readonly ConnectorSide[] = ["top", "right", "bottom", "left"];
const DEFAULT_MINIMUM_NODE_WIDTH = 32;
const DEFAULT_MINIMUM_NODE_HEIGHT = 35;
const DEFAULT_CONNECTOR_HIT_RADIUS = 18;
const RESIZE_PREVIEW_MINIMUM_SIZE = 2;
const RESIZE_PREVIEW_MOVE_EPSILON = 2;
const GRID_EXTENT = 100_000;
const DEFAULT_NODE_WIDTH = 260;
const DEFAULT_NODE_HEIGHT = 92;
const NODE_PADDING_X = 18;
const NODE_PADDING_Y = 14;

export interface CanvasSelection {
  readonly nodeIds: readonly string[];
  readonly arrowIds: readonly string[];
}

export interface CanvasTextChange {
  readonly nodeId: string;
  readonly text: string;
  readonly frame: NodeFrame;
  readonly autoWidth: boolean;
}

export type CanvasTextCommitMode = "normal" | "pointer-handoff";

export type CanvasTextCommitResult =
  | { readonly accepted: true; readonly map: MindMapDocument }
  | { readonly accepted: false };

export interface MindMapCanvasCallbacks {
  onSelectionChange?(selection: CanvasSelection): void;
  onAddNodeRequest?(command: { readonly position: Point }): void;
  onMoveNodes?(command: {
    readonly nodeIds: readonly string[];
    readonly dx: number;
    readonly dy: number;
  }): void;
  onResizeNode?(command: {
    readonly nodeId: string;
    readonly frame: NodeFrame;
    readonly autoWidth: boolean;
  }): void;
  onChangeNodeText?(
    command: CanvasTextChange,
    mode: CanvasTextCommitMode,
  ): CanvasTextCommitResult | void;
  onCreateArrow?(command: {
    readonly from: MindMapEndpoint;
    readonly to: MindMapEndpoint;
  }): void;
  onDeleteSelection?(selection: CanvasSelection): void;
  onViewportChange?(viewport: CanvasViewport): void;
  isArrowTargetValid?(from: MindMapEndpoint, to: MindMapEndpoint): boolean;
}

export interface CanvasMeasurements {
  getCanvasRect(svg: SVGSVGElement): ClientRectLike;
  getSidebarRect?(): ClientRectLike | null;
}

export interface CanvasTextMeasureInput {
  readonly element: HTMLTextAreaElement | null;
  readonly text: string;
  readonly width: number;
}

export interface CanvasTextMetrics {
  readonly naturalWidth: number;
  readonly height: number;
  readonly minimumWidth: number;
  readonly minimumHeight: number;
}

export interface CanvasTextMeasurement {
  measure(input: CanvasTextMeasureInput): CanvasTextMetrics;
}

export interface PointerCaptureAdapter {
  capture(svg: SVGSVGElement, pointerId: number): void;
  release(svg: SVGSVGElement, pointerId: number): void;
}

export interface MindMapCanvasOptions {
  readonly callbacks?: MindMapCanvasCallbacks;
  readonly measurements?: CanvasMeasurements;
  readonly pointerCapture?: PointerCaptureAdapter;
  readonly animationFrames?: AnimationFrameScheduler;
  readonly textMeasurement?: CanvasTextMeasurement;
  readonly minimumNodeWidth?: number;
  readonly minimumNodeHeight?: number;
  readonly connectorHitRadius?: number;
}

type MutableSelection = {
  nodeIds: Set<string>;
  arrowIds: Set<string>;
};

interface PointerInteractionBase {
  readonly pointerId: number;
  lastClient: Point;
}

type PointerInteraction =
  | { readonly kind: "idle" }
  | (PointerInteractionBase & {
      readonly kind: "marquee";
      readonly startWorld: Point;
      currentWorld: Point;
      readonly baseline: MutableSelection;
      readonly additive: boolean;
    })
  | (PointerInteractionBase & {
      readonly kind: "moving";
      readonly startWorld: Point;
      currentWorld: Point;
      readonly nodeIds: readonly string[];
      readonly startFrames: ReadonlyMap<string, NodeFrame>;
    })
  | (PointerInteractionBase & {
      readonly kind: "resizing";
      readonly nodeId: string;
      readonly startFrame: NodeFrame;
      readonly startClient: Point;
      currentFrame: NodeFrame;
      textPaintHeight: number;
      moved: boolean;
    })
  | (PointerInteractionBase & {
      readonly kind: "connecting";
      readonly from: MindMapEndpoint;
      currentWorld: Point;
      target: MindMapEndpoint | null;
    })
  | (PointerInteractionBase & {
      readonly kind: "panning";
      readonly startClient: Point;
      readonly startViewport: CanvasViewport;
    });

interface EditingState {
  readonly nodeId: string;
  readonly originalText: string;
  readonly originalFrame: NodeFrame;
  readonly originalAutoWidth: boolean;
  currentFrame: NodeFrame;
  currentAutoWidth: boolean;
}

interface TextCommitResult {
  readonly change: CanvasTextChange | null;
  readonly accepted: boolean;
}

export class MindMapCanvas {
  readonly #ownerDocument: Document;
  readonly #callbacks: MindMapCanvasCallbacks;
  readonly #measurements: CanvasMeasurements;
  readonly #pointerCapture: PointerCaptureAdapter;
  readonly #textMeasurement: CanvasTextMeasurement;
  readonly #minimumNodeWidth: number;
  readonly #minimumNodeHeight: number;
  readonly #connectorHitRadiusSquared: number;
  readonly #svg: SVGSVGElement;
  readonly #viewportLayer: SVGGElement;
  readonly #grid: SVGRectElement;
  readonly #arrowLayer: SVGGElement;
  readonly #nodeLayer: SVGGElement;
  readonly #overlayLayer: SVGGElement;
  readonly #markerId: string;
  readonly #viewportsByDocumentId = new Map<string, CanvasViewport>();
  readonly #frameOverrides = new Map<string, NodeFrame>();
  readonly #autoPan: EdgeAutoPan;

  #map: MindMapDocument | null = null;
  #viewport: CanvasViewport = { ...IDENTITY_VIEWPORT };
  #selection: MutableSelection = emptySelection();
  #interaction: PointerInteraction = { kind: "idle" };
  #editing: EditingState | null = null;
  #arrowMode = false;
  #suppressBlur = false;
  #destroyed = false;

  constructor(host: HTMLElement, options: MindMapCanvasOptions = {}) {
    this.#ownerDocument = host.ownerDocument;
    this.#callbacks = options.callbacks ?? {};
    this.#measurements = options.measurements ?? defaultMeasurements();
    this.#pointerCapture = options.pointerCapture ?? defaultPointerCapture();
    this.#textMeasurement = options.textMeasurement ?? new BrowserTextMeasurement(this.#ownerDocument);
    this.#minimumNodeWidth = positive(options.minimumNodeWidth, DEFAULT_MINIMUM_NODE_WIDTH);
    this.#minimumNodeHeight = positive(options.minimumNodeHeight, DEFAULT_MINIMUM_NODE_HEIGHT);
    const connectorHitRadius = positive(options.connectorHitRadius, DEFAULT_CONNECTOR_HIT_RADIUS);
    this.#connectorHitRadiusSquared = connectorHitRadius * connectorHitRadius;
    this.#markerId = `mind-map-arrow-${Math.random().toString(16).slice(2)}`;

    this.#svg = createSvg(this.#ownerDocument, "svg");
    this.#svg.classList.add("mind-map-canvas");
    this.#svg.setAttribute("role", "application");
    this.#svg.setAttribute("aria-label", "思维导图画布");
    this.#svg.setAttribute("tabindex", "0");
    this.#svg.append(this.#createDefinitions());

    this.#viewportLayer = createSvg(this.#ownerDocument, "g");
    this.#viewportLayer.classList.add("mind-map-canvas__viewport");
    this.#grid = createSvg(this.#ownerDocument, "rect");
    this.#grid.classList.add("mind-map-canvas__grid");
    this.#grid.setAttribute("x", String(-GRID_EXTENT));
    this.#grid.setAttribute("y", String(-GRID_EXTENT));
    this.#grid.setAttribute("width", String(GRID_EXTENT * 2));
    this.#grid.setAttribute("height", String(GRID_EXTENT * 2));
    this.#grid.setAttribute("fill", `url(#${this.#markerId}-grid)`);

    this.#arrowLayer = createSvg(this.#ownerDocument, "g");
    this.#arrowLayer.classList.add("mind-map-canvas__arrows");
    this.#nodeLayer = createSvg(this.#ownerDocument, "g");
    this.#nodeLayer.classList.add("mind-map-canvas__nodes");
    this.#overlayLayer = createSvg(this.#ownerDocument, "g");
    this.#overlayLayer.classList.add("mind-map-canvas__overlays");
    this.#viewportLayer.append(this.#grid, this.#arrowLayer, this.#nodeLayer, this.#overlayLayer);
    this.#svg.append(this.#viewportLayer);
    host.replaceChildren(this.#svg);

    this.#svg.addEventListener("pointerdown", this.#onRootPointerDown);
    this.#svg.addEventListener("pointermove", this.#onPointerMove);
    this.#svg.addEventListener("pointerup", this.#onPointerUp);
    this.#svg.addEventListener("pointercancel", this.#onPointerCancel);
    this.#svg.addEventListener("wheel", this.#onWheel, { passive: false });
    this.#svg.addEventListener("contextmenu", this.#onContextMenu);
    this.#svg.addEventListener("keydown", this.#onKeyDown);

    this.#autoPan = new EdgeAutoPan({
      getPointer: () => this.#autoPanPointer(),
      getBounds: () => this.#visibleCanvasRect(),
      onPan: (delta) => this.#applyAutoPan(delta),
      scheduler: options.animationFrames,
    });
    this.#applyViewport();
  }

  get element(): SVGSVGElement {
    return this.#svg;
  }

  get arrowMode(): boolean {
    return this.#arrowMode;
  }

  project(
    map: MindMapDocument | null,
    options: { readonly viewport?: CanvasViewport; readonly fitIfNew?: boolean } = {},
  ): void {
    this.#assertAlive();
    const previousId = this.#map?.id;
    if (previousId) this.#viewportsByDocumentId.set(previousId, this.#viewport);

    this.#cancelPointerInteraction(true);
    this.#discardTextEdit();
    this.#arrowMode = false;
    this.#map = map;
    this.#selection = emptySelection();
    this.#frameOverrides.clear();

    if (options.viewport) {
      this.#viewport = normalizeViewport(options.viewport);
    } else if (map && this.#viewportsByDocumentId.has(map.id)) {
      this.#viewport = this.#viewportsByDocumentId.get(map.id)!;
    } else if (map && options.fitIfNew !== false) {
      this.#viewport = this.#fitMap(map);
    } else {
      this.#viewport = { ...IDENTITY_VIEWPORT };
    }

    if (map) {
      this.#viewportsByDocumentId.set(map.id, this.#viewport);
    }
    this.#applyViewport();
    this.#render();
    this.#emitSelection();
  }

  /** Updates committed data after a normal dispatch while preserving session UI state. */
  render(map: MindMapDocument | null): void {
    this.#assertAlive();
    if (!map || !this.#map || map.id !== this.#map.id) {
      this.project(map);
      return;
    }
    this.#map = map;
    const nodeIds = new Set(map.nodes.map((node) => node.id));
    const arrowIds = new Set(map.arrows.map((arrow) => arrow.id));
    const nextSelection: MutableSelection = {
      nodeIds: new Set([...this.#selection.nodeIds].filter((id) => nodeIds.has(id))),
      arrowIds: new Set([...this.#selection.arrowIds].filter((id) => arrowIds.has(id))),
    };
    const selectionChanged = !selectionsEqual(this.#selection, nextSelection);
    this.#selection = nextSelection;
    if (this.#editing && !nodeIds.has(this.#editing.nodeId)) this.#editing = null;
    this.#render();
    if (selectionChanged) this.#emitSelection();
  }

  getSelection(): CanvasSelection {
    return selectionSnapshot(this.#selection);
  }

  setSelection(selection: CanvasSelection): void {
    this.#assertAlive();
    const map = this.#map;
    if (!map) {
      this.clearSelection();
      return;
    }
    const nodeIds = new Set(map.nodes.map((node) => node.id));
    const arrowIds = new Set(map.arrows.map((arrow) => arrow.id));
    this.#setSelection({
      nodeIds: new Set(selection.nodeIds.filter((id) => nodeIds.has(id))),
      arrowIds: new Set(selection.arrowIds.filter((id) => arrowIds.has(id))),
    });
  }

  clearSelection(): void {
    this.#assertAlive();
    this.#setSelection(emptySelection());
  }

  /** Cancels pointer work and returns, but does not dispatch, one pending text change. */
  settleLiveInteraction(): CanvasTextChange | null {
    this.#assertAlive();
    const textChange = this.#takeTextChange();
    this.#cancelPointerInteraction(true);
    this.#arrowMode = false;
    this.#selection = emptySelection();
    this.#render();
    this.#emitSelection();
    return textChange;
  }

  hasPendingTextChange(): boolean {
    this.#assertAlive();
    const editing = this.#editing;
    if (!editing) return false;
    const text = this.#findTextarea(editing.nodeId)?.value ?? editing.originalText;
    return (
      text !== editing.originalText ||
      !framesEqual(editing.currentFrame, editing.originalFrame) ||
      editing.currentAutoWidth !== editing.originalAutoWidth
    );
  }

  cancelLiveInteraction(): void {
    this.#assertAlive();
    this.#cancelPointerInteraction(true);
    this.#discardTextEdit();
    this.#arrowMode = false;
    this.#render();
  }

  commitActiveTextEdit(): CanvasTextChange | null {
    this.#assertAlive();
    const previousEdit = this.#editing;
    const previousText = previousEdit
      ? this.#findTextarea(previousEdit.nodeId)?.value ?? previousEdit.originalText
      : "";
    const committed = this.#commitTextEdit("normal");
    if (!committed.accepted && previousEdit) {
      this.#restoreTextEdit(previousEdit, previousText);
      return null;
    }
    this.#render();
    return committed.change;
  }

  requestAddNode(): void {
    this.#assertAlive();
    if (!this.#map) return;
    this.commitActiveTextEdit();
    this.#cancelPointerInteraction(true);
    this.#arrowMode = false;
    this.clearSelection();
    const rect = this.#visibleCanvasRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    this.#callbacks.onAddNodeRequest?.({
      position: clientToWorld(center, this.#canvasRect(), this.#viewport),
    });
  }

  editNode(nodeId: string): void {
    this.#assertAlive();
    const node = this.#findNode(nodeId);
    if (!node) return;
    if (this.#editing?.nodeId === nodeId) {
      this.#focusEditor(nodeId, false);
      return;
    }
    this.commitActiveTextEdit();
    this.#cancelPointerInteraction(true);
    this.#arrowMode = false;
    this.#selection = { nodeIds: new Set([nodeId]), arrowIds: new Set() };
    const frame = this.#effectiveFrame(node);
    this.#editing = {
      nodeId,
      originalText: node.text,
      originalFrame: frame,
      originalAutoWidth: node.autoWidth,
      currentFrame: frame,
      currentAutoWidth: node.autoWidth,
    };
    this.#render();
    this.#emitSelection();
    this.#focusEditor(nodeId, true);
  }

  setArrowMode(enabled: boolean): void {
    this.#assertAlive();
    if (enabled === this.#arrowMode && this.#interaction.kind !== "connecting") return;
    this.commitActiveTextEdit();
    this.#cancelPointerInteraction(true);
    this.#arrowMode = enabled && this.#map !== null;
    this.#selection = emptySelection();
    this.#render();
    this.#emitSelection();
  }

  toggleArrowMode(): void {
    this.setArrowMode(!this.#arrowMode);
  }

  getViewport(): CanvasViewport {
    return { ...this.#viewport };
  }

  setViewport(viewport: CanvasViewport): void {
    this.#assertAlive();
    this.#setViewport(normalizeViewport(viewport), true);
  }

  resetViewport(): CanvasViewport {
    this.#assertAlive();
    const viewport = this.#map ? this.#fitMap(this.#map) : { ...IDENTITY_VIEWPORT };
    this.#setViewport(viewport, true);
    return this.getViewport();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#autoPan.destroy();
    this.#cancelPointerInteraction(true);
    this.#discardTextEdit();
    this.#svg.removeEventListener("pointerdown", this.#onRootPointerDown);
    this.#svg.removeEventListener("pointermove", this.#onPointerMove);
    this.#svg.removeEventListener("pointerup", this.#onPointerUp);
    this.#svg.removeEventListener("pointercancel", this.#onPointerCancel);
    this.#svg.removeEventListener("wheel", this.#onWheel);
    this.#svg.removeEventListener("contextmenu", this.#onContextMenu);
    this.#svg.removeEventListener("keydown", this.#onKeyDown);
    this.#svg.remove();
  }

  dispose(): void {
    this.destroy();
  }

  readonly #onRootPointerDown = (event: PointerEvent): void => {
    if (!this.#map || !this.#isBlankTarget(event.target)) return;
    const client = eventPoint(event);
    if (event.button === 2) {
      event.preventDefault();
      this.commitActiveTextEdit();
      this.#beginPointerInteraction({
        kind: "panning",
        pointerId: pointerId(event),
        startClient: client,
        lastClient: client,
        startViewport: this.#viewport,
      });
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    this.commitActiveTextEdit();
    if (this.#arrowMode) {
      this.setArrowMode(false);
      return;
    }

    const startWorld = this.#toWorld(client);
    const additive = event.ctrlKey;
    const baseline = additive ? cloneSelection(this.#selection) : emptySelection();
    if (!additive) this.#setSelection(emptySelection());
    this.#beginPointerInteraction({
      kind: "marquee",
      pointerId: pointerId(event),
      startWorld,
      currentWorld: startWorld,
      lastClient: client,
      baseline,
      additive,
    });
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    if (this.#interaction.kind === "idle" || pointerId(event) !== this.#interaction.pointerId) return;
    event.preventDefault();
    this.#interaction.lastClient = eventPoint(event);
    this.#updatePointerInteraction();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const interaction = this.#interaction;
    if (interaction.kind === "idle" || pointerId(event) !== interaction.pointerId) return;
    event.preventDefault();
    interaction.lastClient = eventPoint(event);
    this.#updatePointerInteraction();
    this.#finishPointerInteraction();
  };

  readonly #onPointerCancel = (event: PointerEvent): void => {
    const interaction = this.#interaction;
    if (interaction.kind === "idle" || pointerId(event) !== interaction.pointerId) return;
    if (interaction.kind === "marquee") this.#selection = cloneSelection(interaction.baseline);
    if (interaction.kind === "connecting") this.#arrowMode = false;
    this.#cancelPointerInteraction(true);
    this.#render();
    this.#emitSelection();
  };

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.#canvasRect();
    const viewport = zoomAtClientPoint(
      this.#viewport,
      rect,
      eventPoint(event),
      wheelZoomScale(this.#viewport.scale, event.deltaY),
    );
    this.#setViewport(viewport, true);
  };

  readonly #onContextMenu = (event: MouseEvent): void => {
    if (this.#isEditingTextarea(event.target)) return;
    event.preventDefault();
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (this.#isEditingTextarea(event.target)) return;
    if (event.key !== "Delete") return;
    const selection = this.getSelection();
    if (selection.nodeIds.length === 0 && selection.arrowIds.length === 0) return;
    event.preventDefault();
    this.#callbacks.onDeleteSelection?.(selection);
  };

  #beginNodeMove(event: PointerEvent, nodeId: string): void {
    if (event.button !== 0 || this.#arrowMode) return;
    event.preventDefault();
    event.stopPropagation();
    this.commitActiveTextEdit();

    if (event.ctrlKey) {
      const next = cloneSelection(this.#selection);
      if (next.nodeIds.has(nodeId)) {
        next.nodeIds.delete(nodeId);
        this.#setSelection(next);
        return;
      }
      next.nodeIds.add(nodeId);
      this.#setSelection(next);
    }
    if (!this.#selection.nodeIds.has(nodeId)) {
      this.#setSelection({ nodeIds: new Set([nodeId]), arrowIds: new Set() });
    }

    const nodeIds = [...this.#selection.nodeIds].sort();
    const startFrames = new Map<string, NodeFrame>();
    for (const id of nodeIds) {
      const node = this.#findNode(id);
      if (node) startFrames.set(id, this.#effectiveFrame(node));
    }
    const client = eventPoint(event);
    this.#beginPointerInteraction({
      kind: "moving",
      pointerId: pointerId(event),
      startWorld: this.#toWorld(client),
      currentWorld: this.#toWorld(client),
      lastClient: client,
      nodeIds,
      startFrames,
    });
  }

  #beginResize(event: PointerEvent, nodeId: string): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.commitActiveTextEdit();
    const node = this.#findNode(nodeId);
    if (!node) return;
    this.#setSelection({ nodeIds: new Set([nodeId]), arrowIds: new Set() });
    const startFrame = this.#effectiveFrame(node);
    const client = eventPoint(event);
    this.#beginPointerInteraction({
      kind: "resizing",
      pointerId: pointerId(event),
      nodeId,
      startFrame,
      startClient: client,
      currentFrame: startFrame,
      textPaintHeight: startFrame.height,
      moved: false,
      lastClient: client,
    });
  }

  #beginConnectorDrag(event: PointerEvent, endpoint: MindMapEndpoint): void {
    if (!this.#arrowMode || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const client = eventPoint(event);
    this.#beginPointerInteraction({
      kind: "connecting",
      pointerId: pointerId(event),
      from: endpoint,
      currentWorld: this.#toWorld(client),
      target: null,
      lastClient: client,
    });
  }

  #selectArrow(event: PointerEvent, arrowId: string): void {
    if (event.button !== 0 || this.#arrowMode) return;
    event.preventDefault();
    event.stopPropagation();
    this.commitActiveTextEdit();
    if (event.ctrlKey) {
      const next = cloneSelection(this.#selection);
      if (next.arrowIds.has(arrowId)) next.arrowIds.delete(arrowId);
      else next.arrowIds.add(arrowId);
      this.#setSelection(next);
      return;
    }
    this.#setSelection({ nodeIds: new Set(), arrowIds: new Set([arrowId]) });
  }

  #handleTextPointerDown(
    event: PointerEvent,
    nodeId: string,
    textarea: HTMLTextAreaElement,
  ): void {
    if (event.button !== 0 || this.#arrowMode) return;
    event.stopPropagation();
    if (event.ctrlKey) {
      event.preventDefault();
      this.commitActiveTextEdit();
      const next = cloneSelection(this.#selection);
      if (next.nodeIds.has(nodeId)) next.nodeIds.delete(nodeId);
      else next.nodeIds.add(nodeId);
      this.#setSelection(next);
      return;
    }
    if (this.#editing?.nodeId === nodeId) return;

    const previousEdit = this.#editing;
    const previousTextarea = previousEdit ? this.#findTextarea(previousEdit.nodeId) : null;
    const previousText = previousTextarea?.value ?? previousEdit?.originalText ?? "";
    const committed = this.#commitTextEdit("pointer-handoff");
    if (!committed.accepted && previousEdit) {
      event.preventDefault();
      this.#restoreTextEdit(previousEdit, previousText);
      return;
    }
    if (previousEdit) this.#renderArrowsOnly();

    this.#cancelPointerInteraction(true);
    const node = this.#findNode(nodeId);
    if (!node || !textarea.isConnected) return;
    this.#selection = { nodeIds: new Set([nodeId]), arrowIds: new Set() };
    const frame = this.#effectiveFrame(node);
    this.#editing = {
      nodeId,
      originalText: node.text,
      originalFrame: frame,
      originalAutoWidth: node.autoWidth,
      currentFrame: frame,
      currentAutoWidth: node.autoWidth,
    };
    this.#syncInteractionChromeInPlace();
    this.#emitSelection();
  }

  #beginPointerInteraction(interaction: Exclude<PointerInteraction, { kind: "idle" }>): void {
    this.#cancelPointerInteraction(true);
    this.#interaction = interaction;
    this.#pointerCapture.capture(this.#svg, interaction.pointerId);
    if (usesAutoPan(interaction)) this.#autoPan.start();
    this.#render();
  }

  #updatePointerInteraction(): void {
    const interaction = this.#interaction;
    if (interaction.kind === "idle") return;

    if (interaction.kind === "panning") {
      const delta = {
        x: interaction.lastClient.x - interaction.startClient.x,
        y: interaction.lastClient.y - interaction.startClient.y,
      };
      this.#setViewport(panViewport(interaction.startViewport, delta), true);
      return;
    }

    const world = this.#toWorld(interaction.lastClient);
    if (interaction.kind === "marquee") {
      interaction.currentWorld = world;
      const candidates = this.#selectionInside(normalizeRect(interaction.startWorld, world));
      this.#selection = interaction.additive
        ? toggleSelection(interaction.baseline, candidates)
        : candidates;
      this.#render();
      this.#emitSelection();
      return;
    }
    if (interaction.kind === "moving") {
      interaction.currentWorld = world;
      const dx = world.x - interaction.startWorld.x;
      const dy = world.y - interaction.startWorld.y;
      for (const [id, frame] of interaction.startFrames) {
        this.#frameOverrides.set(id, translateFrame(frame, dx, dy));
      }
      this.#render();
      return;
    }
    if (interaction.kind === "resizing") {
      interaction.currentFrame = resizeFrameFromSouthEast(
        interaction.startFrame,
        world,
        RESIZE_PREVIEW_MINIMUM_SIZE,
        RESIZE_PREVIEW_MINIMUM_SIZE,
      );
      interaction.moved ||= (
        Math.abs(interaction.lastClient.x - interaction.startClient.x) > RESIZE_PREVIEW_MOVE_EPSILON
        || Math.abs(interaction.lastClient.y - interaction.startClient.y) > RESIZE_PREVIEW_MOVE_EPSILON
      );
      const node = this.#findNode(interaction.nodeId);
      const textarea = this.#findTextarea(interaction.nodeId);
      const textHeight = node
        ? this.#textMeasurement.measure({
            element: textarea,
            text: node.text,
            width: interaction.currentFrame.width,
          }).height
        : interaction.currentFrame.height;
      interaction.textPaintHeight = Math.max(interaction.currentFrame.height, textHeight);
      this.#frameOverrides.set(interaction.nodeId, interaction.currentFrame);
      this.#render();
      return;
    }
    interaction.currentWorld = world;
    interaction.target = this.#findConnectorAtClient(interaction.lastClient, interaction.from);
    this.#render();
  }

  #finishPointerInteraction(): void {
    const interaction = this.#interaction;
    if (interaction.kind === "idle") return;
    this.#autoPan.stop();
    this.#pointerCapture.release(this.#svg, interaction.pointerId);
    this.#interaction = { kind: "idle" };

    if (interaction.kind === "moving") {
      const dx = interaction.currentWorld.x - interaction.startWorld.x;
      const dy = interaction.currentWorld.y - interaction.startWorld.y;
      if (dx !== 0 || dy !== 0) this.#callbacks.onMoveNodes?.({ nodeIds: interaction.nodeIds, dx, dy });
    } else if (interaction.kind === "resizing") {
      const node = this.#findNode(interaction.nodeId);
      const finalized = node
        ? this.#getCommittedResize(node, interaction.currentFrame)
        : { frame: interaction.currentFrame, autoWidth: false };
      if (!framesEqual(interaction.startFrame, finalized.frame) || node?.autoWidth !== finalized.autoWidth) {
        this.#callbacks.onResizeNode?.({
          nodeId: interaction.nodeId,
          frame: finalized.frame,
          autoWidth: finalized.autoWidth,
        });
      }
    } else if (interaction.kind === "connecting") {
      const target = interaction.target;
      this.#arrowMode = false;
      this.#selection = emptySelection();
      if (target) this.#callbacks.onCreateArrow?.({ from: interaction.from, to: target });
      this.#emitSelection();
    }

    this.#frameOverrides.clear();
    this.#render();
  }

  #cancelPointerInteraction(releaseCapture: boolean): void {
    const interaction = this.#interaction;
    if (interaction.kind === "idle") return;
    this.#autoPan.stop();
    if (releaseCapture) this.#pointerCapture.release(this.#svg, interaction.pointerId);
    this.#interaction = { kind: "idle" };
    this.#frameOverrides.clear();
  }

  #takeTextChange(): CanvasTextChange | null {
    const editing = this.#editing;
    if (!editing) return null;
    const textarea = this.#findTextarea(editing.nodeId);
    const text = textarea?.value ?? editing.originalText;
    this.#editing = null;
    this.#frameOverrides.delete(editing.nodeId);
    return (
      text === editing.originalText &&
      framesEqual(editing.currentFrame, editing.originalFrame) &&
      editing.currentAutoWidth === editing.originalAutoWidth
    )
      ? null
      : {
          nodeId: editing.nodeId,
          text,
          frame: editing.currentFrame,
          autoWidth: editing.currentAutoWidth,
        };
  }

  #discardTextEdit(): void {
    if (this.#editing) this.#frameOverrides.delete(this.#editing.nodeId);
    this.#editing = null;
  }

  #commitTextEdit(mode: CanvasTextCommitMode): TextCommitResult {
    const change = this.#takeTextChange();
    if (!change) return { change: null, accepted: true };
    const result = this.#callbacks.onChangeNodeText?.(change, mode);
    if (result === undefined) {
      this.#applyTextChangeToMap(change);
    } else if (!result.accepted || !mapReflectsTextChange(result.map, change)) {
      return { change, accepted: false };
    } else {
      this.#map = result.map;
    }
    return { change, accepted: true };
  }

  #restoreTextEdit(editing: EditingState, text: string): void {
    this.#editing = editing;
    this.#frameOverrides.set(editing.nodeId, editing.currentFrame);
    const textarea = this.#findTextarea(editing.nodeId);
    if (textarea) textarea.value = text;
    this.#applyEditingFrameToDom(editing.nodeId, editing.currentFrame);
    this.#renderArrowsOnly();
    this.#syncInteractionChromeInPlace();
  }

  #applyTextChangeToMap(change: CanvasTextChange): void {
    const map = this.#map;
    if (!map) return;
    this.#map = {
      ...map,
      nodes: map.nodes.map((node) => node.id === change.nodeId
        ? {
            ...node,
            text: change.text,
            x: change.frame.x,
            y: change.frame.y,
            width: change.frame.width,
            height: change.frame.height,
            autoWidth: change.autoWidth,
          }
        : node),
    };
  }

  #focusEditor(nodeId: string, moveCaretToEnd: boolean): void {
    queueMicrotask(() => {
      if (this.#editing?.nodeId !== nodeId) return;
      const textarea = this.#findTextarea(nodeId);
      if (!textarea) return;
      textarea.readOnly = false;
      textarea.tabIndex = 0;
      textarea.focus({ preventScroll: true });
      if (moveCaretToEnd) {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    });
  }

  #previewTextEdit(nodeId: string): void {
    const editing = this.#editing;
    const textarea = this.#findTextarea(nodeId);
    if (!editing || editing.nodeId !== nodeId || !textarea) return;
    const text = textarea.value;
    const fitted = this.#getTextFittedFrame(text, textarea, editing);
    editing.currentFrame = fitted.frame;
    editing.currentAutoWidth = fitted.autoWidth;
    this.#frameOverrides.set(nodeId, fitted.frame);
    this.#applyEditingFrameToDom(nodeId, fitted.frame);
    this.#renderArrowsOnly();
  }

  #getTextFittedFrame(
    text: string,
    element: HTMLTextAreaElement | null,
    edit: EditingState,
  ): { frame: NodeFrame; autoWidth: boolean } {
    const initial = this.#textMeasurement.measure({ element, text, width: edit.originalFrame.width });
    const firstNonEmptyEdit =
      edit.originalText.length === 0 &&
      edit.originalFrame.width === DEFAULT_NODE_WIDTH &&
      edit.originalFrame.height === DEFAULT_NODE_HEIGHT &&
      text.length > 0;
    const width = edit.originalAutoWidth
      ? initial.naturalWidth
      : firstNonEmptyEdit
        ? clamp(initial.naturalWidth, initial.minimumWidth, DEFAULT_NODE_WIDTH)
        : Math.max(initial.minimumWidth, edit.originalFrame.width);
    const measured = this.#textMeasurement.measure({ element, text, width });
    return {
      frame: {
        x: edit.originalFrame.x,
        y: edit.originalFrame.y,
        width,
        height: Math.max(measured.minimumHeight, measured.height),
      },
      autoWidth: edit.originalAutoWidth,
    };
  }

  #getCommittedResize(
    node: MindMapNode,
    draggedFrame: NodeFrame,
  ): { frame: NodeFrame; autoWidth: boolean } {
    const textarea = this.#findTextarea(node.id);
    const initial = this.#textMeasurement.measure({
      element: textarea,
      text: node.text,
      width: draggedFrame.width,
    });
    const minimumWidth = Math.max(this.#minimumNodeWidth, initial.minimumWidth);
    const naturalWidth = Math.max(minimumWidth, initial.naturalWidth);
    const requestedWidth = Math.max(minimumWidth, draggedFrame.width);
    const autoWidth = requestedWidth > naturalWidth;
    const width = autoWidth ? naturalWidth : requestedWidth;
    const measured = this.#textMeasurement.measure({ element: textarea, text: node.text, width });
    return {
      frame: {
        x: draggedFrame.x,
        y: draggedFrame.y,
        width,
        height: Math.max(this.#minimumNodeHeight, measured.minimumHeight, measured.height),
      },
      autoWidth,
    };
  }

  #applyEditingFrameToDom(nodeId: string, frame: NodeFrame): void {
    const group = this.#nodeLayer.querySelector<SVGGElement>(`g[data-node-id="${cssEscape(nodeId)}"]`);
    if (!group) return;
    group.setAttribute("transform", `translate(${frame.x} ${frame.y})`);
    for (const element of group.querySelectorAll<SVGRectElement>(
      ".mind-map-canvas__node-body, .mind-map-canvas__node-move-hit",
    )) {
      element.setAttribute("width", String(frame.width));
      element.setAttribute("height", String(frame.height));
    }
    const foreignObject = group.querySelector<SVGForeignObjectElement>(".mind-map-canvas__node-editor-host");
    foreignObject?.setAttribute("width", String(frame.width));
    foreignObject?.setAttribute("height", String(frame.height));
    const handle = group.querySelector<SVGRectElement>(".mind-map-canvas__resize-handle");
    handle?.setAttribute("x", String(frame.width - 5));
    handle?.setAttribute("y", String(frame.height - 5));
  }

  #selectionInside(rect: Rect): MutableSelection {
    const map = this.#map;
    if (!map) return emptySelection();
    const nodes = new Map(map.nodes.map((node) => [node.id, node]));
    const nodeIds = new Set<string>();
    const arrowIds = new Set<string>();
    for (const node of map.nodes) {
      if (rectFullyContainsRect(rect, this.#effectiveFrame(node))) nodeIds.add(node.id);
    }
    for (const arrow of map.arrows) {
      const line = arrowLine(arrow, nodes, (node) => this.#effectiveFrame(node));
      if (line && rectFullyContainsLine(rect, line)) arrowIds.add(arrow.id);
    }
    return { nodeIds, arrowIds };
  }

  #findConnectorAtClient(client: Point, from: MindMapEndpoint): MindMapEndpoint | null {
    const map = this.#map;
    if (!map) return null;
    let best: MindMapEndpoint | null = null;
    let bestDistance = this.#connectorHitRadiusSquared;
    const canvasRect = this.#canvasRect();
    for (const node of map.nodes) {
      const frame = this.#effectiveFrame(node);
      for (const side of CONNECTOR_SIDES) {
        const endpoint: MindMapEndpoint = { nodeId: node.id, side };
        if (!this.#isArrowTargetValid(from, endpoint)) continue;
        const connectorClient = worldToClient(connectorMidpoint(frame, side), canvasRect, this.#viewport);
        const distance = squaredDistance(client, connectorClient);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = endpoint;
        }
      }
    }
    return best;
  }

  #isArrowTargetValid(from: MindMapEndpoint, to: MindMapEndpoint): boolean {
    if (this.#callbacks.isArrowTargetValid) return this.#callbacks.isArrowTargetValid(from, to);
    return from.nodeId !== to.nodeId;
  }

  #autoPanPointer(): Point | null {
    const interaction = this.#interaction;
    if (interaction.kind === "resizing" && !interaction.moved) return null;
    return usesAutoPan(interaction) ? interaction.lastClient : null;
  }

  #applyAutoPan(delta: Point): void {
    if (!usesAutoPan(this.#interaction)) return;
    this.#setViewport(panViewport(this.#viewport, delta), true);
    this.#updatePointerInteraction();
  }

  #setSelection(selection: MutableSelection): void {
    if (selectionsEqual(this.#selection, selection)) return;
    this.#selection = selection;
    this.#render();
    this.#emitSelection();
  }

  #emitSelection(): void {
    this.#callbacks.onSelectionChange?.(this.getSelection());
  }

  #setViewport(viewport: CanvasViewport, emit: boolean): void {
    this.#viewport = viewport;
    if (this.#map) this.#viewportsByDocumentId.set(this.#map.id, viewport);
    this.#applyViewport();
    if (emit) this.#callbacks.onViewportChange?.(this.getViewport());
  }

  #applyViewport(): void {
    this.#viewportLayer.setAttribute(
      "transform",
      `translate(${this.#viewport.offsetX} ${this.#viewport.offsetY}) scale(${this.#viewport.scale})`,
    );
  }

  #fitMap(map: MindMapDocument): CanvasViewport {
    return fitFramesInViewport(map.nodes.map(nodeFrame), {
      canvasRect: this.#canvasRect(),
      sidebarRect: this.#measurements.getSidebarRect?.(),
    });
  }

  #toWorld(client: Point): Point {
    return clientToWorld(client, this.#canvasRect(), this.#viewport);
  }

  #canvasRect(): ClientRectLike {
    return this.#measurements.getCanvasRect(this.#svg);
  }

  #visibleCanvasRect(): ClientRectLike {
    return visibleCanvasRect(this.#canvasRect(), this.#measurements.getSidebarRect?.());
  }

  #effectiveFrame(node: MindMapNode): NodeFrame {
    return this.#frameOverrides.get(node.id) ?? nodeFrame(node);
  }

  #findNode(id: string): MindMapNode | null {
    return this.#map?.nodes.find((node) => node.id === id) ?? null;
  }

  #findTextarea(nodeId: string): HTMLTextAreaElement | null {
    return this.#nodeLayer.querySelector<HTMLTextAreaElement>(
      `textarea[data-node-id="${cssEscape(nodeId)}"]`,
    );
  }

  #render(): void {
    if (this.#destroyed) return;
    this.#updateRootClasses();
    const map = this.#map;
    this.#suppressBlur = true;
    try {
      this.#arrowLayer.replaceChildren();
      this.#nodeLayer.replaceChildren();
      this.#overlayLayer.replaceChildren();
      if (!map) return;

      const nodes = new Map(map.nodes.map((node) => [node.id, node]));
      this.#renderArrowsOnly(nodes);

      const orderedNodes = map.nodes
        .map((node, index) => ({ node, index, rank: this.#nodeRaiseRank(node.id) }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index);
      for (const item of orderedNodes) this.#nodeLayer.append(this.#createNodeElement(item.node));
      this.#renderInteractionOverlay();
    } finally {
      this.#suppressBlur = false;
    }
  }

  #updateRootClasses(): void {
    this.#svg.classList.toggle("is-arrow-mode", this.#arrowMode);
    for (const kind of ["marquee", "moving", "resizing", "connecting", "panning"] as const) {
      this.#svg.classList.toggle(`is-${kind}`, this.#interaction.kind === kind);
    }
  }

  #createArrowElement(id: string, from: Point, to: Point): SVGGElement {
    const group = createSvg(this.#ownerDocument, "g");
    group.classList.add("mind-map-canvas__arrow");
    if (this.#selection.arrowIds.has(id)) group.classList.add("is-selected");
    group.dataset.arrowId = id;
    const line = createSvg(this.#ownerDocument, "line");
    line.classList.add("mind-map-canvas__arrow-line");
    setLine(line, from, to);
    line.setAttribute("marker-end", `url(#${this.#markerId})`);
    const hit = createSvg(this.#ownerDocument, "line");
    hit.classList.add("mind-map-canvas__arrow-hit");
    setLine(hit, from, to);
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "14");
    hit.setAttribute("pointer-events", "stroke");
    hit.addEventListener("pointerdown", (event) => this.#selectArrow(event, id));
    group.append(line, hit);
    return group;
  }

  #createNodeElement(node: MindMapNode): SVGGElement {
    const frame = this.#effectiveFrame(node);
    const editorHeight = this.#nodeEditorHeight(node.id, frame);
    const group = createSvg(this.#ownerDocument, "g");
    group.classList.add("mind-map-canvas__node", this.#nodeStateClass(node.id));
    if (this.#selection.nodeIds.has(node.id)) group.classList.add("is-selected");
    if (this.#nodeRaiseRank(node.id) > 0) group.classList.add("is-raised");
    group.dataset.nodeId = node.id;
    group.setAttribute("transform", `translate(${frame.x} ${frame.y})`);

    const body = createSvg(this.#ownerDocument, "rect");
    body.classList.add("mind-map-canvas__node-body");
    body.setAttribute("width", String(frame.width));
    body.setAttribute("height", String(frame.height));

    const foreignObject = createSvg(this.#ownerDocument, "foreignObject");
    foreignObject.classList.add("mind-map-canvas__node-editor-host");
    foreignObject.setAttribute("width", String(frame.width));
    foreignObject.setAttribute("height", String(editorHeight));
    const textarea = this.#ownerDocument.createElementNS(XHTML_NAMESPACE, "textarea") as HTMLTextAreaElement;
    textarea.classList.add("mind-map-canvas__node-editor");
    textarea.dataset.nodeId = node.id;
    textarea.value = node.text;
    textarea.readOnly = this.#editing?.nodeId !== node.id;
    textarea.tabIndex = textarea.readOnly ? -1 : 0;
    textarea.setAttribute("aria-label", "节点文本");
    textarea.addEventListener(
      "pointerdown",
      (event) => this.#handleTextPointerDown(event, node.id, textarea),
    );
    textarea.addEventListener("click", (event) => {
      if (
        !event.ctrlKey
        && !this.#arrowMode
        && this.#editing?.nodeId !== node.id
      ) this.editNode(node.id);
    });
    textarea.addEventListener("blur", () => {
      if (this.#suppressBlur || this.#editing?.nodeId !== node.id) return;
      this.commitActiveTextEdit();
    });
    textarea.addEventListener("input", () => this.#previewTextEdit(node.id));
    foreignObject.append(textarea);

    const moveHit = createSvg(this.#ownerDocument, "rect");
    moveHit.classList.add("mind-map-canvas__node-move-hit");
    moveHit.setAttribute("x", "0");
    moveHit.setAttribute("y", "0");
    moveHit.setAttribute("width", String(frame.width));
    moveHit.setAttribute("height", String(frame.height));
    moveHit.setAttribute("fill", "none");
    moveHit.setAttribute("stroke", "transparent");
    moveHit.setAttribute("stroke-width", "12");
    moveHit.setAttribute("pointer-events", "stroke");
    moveHit.addEventListener("pointerdown", (event) => this.#beginNodeMove(event, node.id));
    group.append(body, foreignObject, moveHit);

    if (this.#shouldShowResizeHandle(node.id)) group.append(this.#createResizeHandle(node.id, frame));

    if (this.#arrowMode) {
      for (const side of CONNECTOR_SIDES) {
        const point = connectorMidpoint({ x: 0, y: 0, width: frame.width, height: frame.height }, side);
        const connector = createSvg(this.#ownerDocument, "circle");
        connector.classList.add("mind-map-canvas__connector", `mind-map-canvas__connector--${side}`);
        const endpoint = { nodeId: node.id, side } satisfies MindMapEndpoint;
        if (endpointEqual(this.#connectingTarget(), endpoint)) connector.classList.add("is-target");
        if (endpointEqual(this.#connectingSource(), endpoint)) connector.classList.add("is-source");
        connector.dataset.nodeId = node.id;
        connector.dataset.side = side;
        connector.setAttribute("cx", String(point.x));
        connector.setAttribute("cy", String(point.y));
        connector.setAttribute("r", "5");
        connector.addEventListener("pointerdown", (event) => this.#beginConnectorDrag(event, endpoint));
        group.append(connector);
      }
    }
    return group;
  }

  #createResizeHandle(nodeId: string, frame: NodeFrame): SVGRectElement {
    const handle = createSvg(this.#ownerDocument, "rect");
    handle.classList.add("mind-map-canvas__resize-handle");
    handle.dataset.nodeId = nodeId;
    handle.setAttribute("x", String(frame.width - 5));
    handle.setAttribute("y", String(frame.height - 5));
    handle.setAttribute("width", "10");
    handle.setAttribute("height", "10");
    handle.addEventListener("pointerdown", (event) => this.#beginResize(event, nodeId));
    return handle;
  }

  #syncInteractionChromeInPlace(): void {
    this.#updateRootClasses();
    for (const group of this.#arrowLayer.querySelectorAll<SVGGElement>(".mind-map-canvas__arrow")) {
      const arrowId = group.dataset.arrowId;
      group.classList.toggle("is-selected", Boolean(arrowId && this.#selection.arrowIds.has(arrowId)));
    }

    const map = this.#map;
    if (!map) return;
    const groups = new Map<string, SVGGElement>();
    for (const group of this.#nodeLayer.querySelectorAll<SVGGElement>(".mind-map-canvas__node")) {
      if (group.dataset.nodeId) groups.set(group.dataset.nodeId, group);
    }
    for (const node of map.nodes) {
      const group = groups.get(node.id);
      if (!group) continue;
      group.classList.remove("is-idle", "is-moving", "is-resizing", "is-editing");
      group.classList.add(this.#nodeStateClass(node.id));
      group.classList.toggle("is-selected", this.#selection.nodeIds.has(node.id));
      group.classList.toggle("is-raised", this.#nodeRaiseRank(node.id) > 0);

      const editor = group.querySelector<HTMLTextAreaElement>(".mind-map-canvas__node-editor");
      if (editor) {
        const editing = this.#editing?.nodeId === node.id;
        editor.readOnly = !editing;
        editor.tabIndex = editing ? 0 : -1;
      }

      const handle = group.querySelector<SVGRectElement>(".mind-map-canvas__resize-handle");
      if (!this.#shouldShowResizeHandle(node.id)) {
        handle?.remove();
      } else if (!handle) {
        group.append(this.#createResizeHandle(node.id, this.#effectiveFrame(node)));
      }
    }
    // Re-inserting a node group here can break the native caret/selection gesture
    // that is still being established for this pointerdown. The next full render
    // restores rank order without replacing the active pointer target mid-gesture.
  }

  #renderArrowsOnly(nodes?: ReadonlyMap<string, MindMapNode>): void {
    this.#arrowLayer.replaceChildren();
    const map = this.#map;
    if (!map) return;
    const nodeById = nodes ?? new Map(map.nodes.map((node) => [node.id, node]));
    for (const arrow of map.arrows) {
      const line = arrowLine(arrow, nodeById, (node) => this.#effectiveFrame(node));
      if (line) this.#arrowLayer.append(this.#createArrowElement(arrow.id, line.from, line.to));
    }
  }

  #renderInteractionOverlay(): void {
    const interaction = this.#interaction;
    if (interaction.kind === "marquee") {
      const rect = normalizeRect(interaction.startWorld, interaction.currentWorld);
      const element = createSvg(this.#ownerDocument, "rect");
      element.classList.add("mind-map-canvas__marquee");
      setRect(element, rect);
      this.#overlayLayer.append(element);
    } else if (interaction.kind === "connecting") {
      const sourceNode = this.#findNode(interaction.from.nodeId);
      if (!sourceNode) return;
      const from = connectorMidpoint(this.#effectiveFrame(sourceNode), interaction.from.side);
      const toNode = interaction.target ? this.#findNode(interaction.target.nodeId) : null;
      const to = interaction.target && toNode
        ? connectorMidpoint(this.#effectiveFrame(toNode), interaction.target.side)
        : interaction.currentWorld;
      const preview = createSvg(this.#ownerDocument, "line");
      preview.classList.add("mind-map-canvas__arrow-preview");
      setLine(preview, from, to);
      this.#overlayLayer.append(preview);
    }
  }

  #createDefinitions(): SVGDefsElement {
    const defs = createSvg(this.#ownerDocument, "defs");
    const marker = createSvg(this.#ownerDocument, "marker");
    marker.id = this.#markerId;
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto");
    const arrowHead = createSvg(this.#ownerDocument, "path");
    arrowHead.classList.add("mind-map-canvas__arrow-head");
    arrowHead.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.append(arrowHead);

    const pattern = createSvg(this.#ownerDocument, "pattern");
    pattern.id = `${this.#markerId}-grid`;
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    pattern.setAttribute("width", "24");
    pattern.setAttribute("height", "24");
    const gridPath = createSvg(this.#ownerDocument, "path");
    gridPath.classList.add("mind-map-canvas__grid-line");
    gridPath.setAttribute("d", "M 24 0 L 0 0 0 24");
    gridPath.setAttribute("fill", "none");
    pattern.append(gridPath);
    defs.append(marker, pattern);
    return defs;
  }

  #nodeStateClass(nodeId: string): string {
    if (this.#editing?.nodeId === nodeId) return "is-editing";
    if (
      this.#interaction.kind === "resizing"
      && this.#interaction.nodeId === nodeId
      && this.#interaction.moved
    ) return "is-resizing";
    if (this.#selection.nodeIds.has(nodeId)) return "is-moving";
    return "is-idle";
  }

  #nodeEditorHeight(nodeId: string, frame: NodeFrame): number {
    const interaction = this.#interaction;
    return (
      interaction.kind === "resizing"
      && interaction.nodeId === nodeId
    )
      ? Math.max(frame.height, interaction.textPaintHeight)
      : frame.height;
  }

  #nodeRaiseRank(nodeId: string): number {
    if (
      this.#editing?.nodeId === nodeId ||
      (this.#interaction.kind === "resizing" && this.#interaction.nodeId === nodeId) ||
      (this.#interaction.kind === "moving" && this.#interaction.nodeIds.includes(nodeId))
    ) return 2;
    return this.#selection.nodeIds.has(nodeId) ? 1 : 0;
  }

  #shouldShowResizeHandle(nodeId: string): boolean {
    if (this.#editing?.nodeId === nodeId) return true;
    return (
      this.#selection.nodeIds.size === 1 &&
      this.#selection.arrowIds.size === 0 &&
      this.#selection.nodeIds.has(nodeId)
    );
  }

  #connectingSource(): MindMapEndpoint | null {
    return this.#interaction.kind === "connecting" ? this.#interaction.from : null;
  }

  #connectingTarget(): MindMapEndpoint | null {
    return this.#interaction.kind === "connecting" ? this.#interaction.target : null;
  }

  #isBlankTarget(target: EventTarget | null): boolean {
    return target === this.#svg || target === this.#grid;
  }

  #isEditingTextarea(target: EventTarget | null): boolean {
    return (
      target instanceof this.#ownerDocument.defaultView!.HTMLTextAreaElement &&
      this.#editing?.nodeId === target.dataset.nodeId
    );
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error("MindMapCanvas is disposed.");
  }
}

function createSvg<K extends keyof SVGElementTagNameMap>(
  ownerDocument: Document,
  name: K,
): SVGElementTagNameMap[K] {
  return ownerDocument.createElementNS(SVG_NAMESPACE, name);
}

function defaultMeasurements(): CanvasMeasurements {
  return {
    getCanvasRect(svg) {
      const rect = svg.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    },
  };
}

function defaultPointerCapture(): PointerCaptureAdapter {
  return {
    capture(svg, pointerId) {
      if (typeof svg.setPointerCapture === "function") svg.setPointerCapture(pointerId);
    },
    release(svg, pointerId) {
      if (typeof svg.hasPointerCapture === "function" && svg.hasPointerCapture(pointerId)) {
        svg.releasePointerCapture(pointerId);
      }
    },
  };
}

function eventPoint(event: MouseEvent): Point {
  return { x: event.clientX, y: event.clientY };
}

function pointerId(event: PointerEvent): number {
  return Number.isFinite(event.pointerId) ? event.pointerId : 1;
}

function emptySelection(): MutableSelection {
  return { nodeIds: new Set(), arrowIds: new Set() };
}

function cloneSelection(selection: MutableSelection): MutableSelection {
  return { nodeIds: new Set(selection.nodeIds), arrowIds: new Set(selection.arrowIds) };
}

function selectionSnapshot(selection: MutableSelection): CanvasSelection {
  return {
    nodeIds: [...selection.nodeIds].sort(),
    arrowIds: [...selection.arrowIds].sort(),
  };
}

function toggleSelection(baseline: MutableSelection, candidates: MutableSelection): MutableSelection {
  const result = cloneSelection(baseline);
  for (const id of candidates.nodeIds) {
    if (result.nodeIds.has(id)) result.nodeIds.delete(id);
    else result.nodeIds.add(id);
  }
  for (const id of candidates.arrowIds) {
    if (result.arrowIds.has(id)) result.arrowIds.delete(id);
    else result.arrowIds.add(id);
  }
  return result;
}

function selectionsEqual(left: MutableSelection, right: MutableSelection): boolean {
  return setsEqual(left.nodeIds, right.nodeIds) && setsEqual(left.arrowIds, right.arrowIds);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function framesEqual(left: NodeFrame, right: NodeFrame): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function mapReflectsTextChange(map: MindMapDocument, change: CanvasTextChange): boolean {
  const node = map.nodes.find((candidate) => candidate.id === change.nodeId);
  return Boolean(
    node
    && node.text === change.text
    && node.autoWidth === change.autoWidth
    && framesEqual(nodeFrame(node), change.frame),
  );
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

function usesAutoPan(
  interaction: PointerInteraction,
): interaction is Extract<PointerInteraction, { kind: "marquee" | "moving" | "resizing" | "connecting" }> {
  return (
    interaction.kind === "marquee" ||
    interaction.kind === "moving" ||
    interaction.kind === "resizing" ||
    interaction.kind === "connecting"
  );
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function cssEscape(value: string): string {
  const css = globalThis.CSS as { escape?: (input: string) => string } | undefined;
  return css?.escape ? css.escape(value) : value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

class BrowserTextMeasurement implements CanvasTextMeasurement {
  constructor(private readonly ownerDocument: Document) {}

  measure(input: CanvasTextMeasureInput): CanvasTextMetrics {
    const view = this.ownerDocument.defaultView;
    const style = input.element && view ? view.getComputedStyle(input.element) : null;
    const fontSize = finiteCssNumber(style?.fontSize, 15);
    const lineHeight = finiteCssNumber(style?.lineHeight, fontSize * 1.35);
    const measure = createTextWidthMeasure(this.ownerDocument, style?.font, fontSize);
    const logicalLines = input.text.length === 0 ? ["M"] : input.text.split("\n");
    const naturalContentWidth = Math.max(...logicalLines.map((line) => measure(line.length > 0 ? line : "M")));
    const characterWidth = Math.max(1, measure("字"));
    const minimumWidth = Math.max(DEFAULT_MINIMUM_NODE_WIDTH, Math.ceil(characterWidth + NODE_PADDING_X));
    const minimumHeight = Math.max(DEFAULT_MINIMUM_NODE_HEIGHT, Math.ceil(lineHeight + NODE_PADDING_Y));
    const availableContentWidth = Math.max(1, input.width - NODE_PADDING_X);
    let visualLineCount = 0;

    for (const logicalLine of logicalLines) {
      if (logicalLine.length === 0) {
        visualLineCount += 1;
        continue;
      }
      let lineWidth = 0;
      let lines = 1;
      for (const character of logicalLine) {
        const width = Math.max(1, measure(character));
        if (lineWidth > 0 && lineWidth + width > availableContentWidth) {
          lines += 1;
          lineWidth = width;
        } else {
          lineWidth += width;
        }
      }
      visualLineCount += lines;
    }

    return {
      naturalWidth: Math.max(minimumWidth, Math.ceil(naturalContentWidth + NODE_PADDING_X)),
      height: Math.max(minimumHeight, Math.ceil(visualLineCount * lineHeight + NODE_PADDING_Y)),
      minimumWidth,
      minimumHeight,
    };
  }
}

function createTextWidthMeasure(
  ownerDocument: Document,
  font: string | undefined,
  fontSize: number,
): (text: string) => number {
  try {
    const context = ownerDocument.createElement("canvas").getContext("2d");
    if (context) {
      if (font) context.font = font;
      return (text) => context.measureText(text).width;
    }
  } catch {
    // jsdom and restricted browsers can lack a canvas text implementation.
  }
  return (text) => [...text].length * fontSize * 0.8;
}

function finiteCssNumber(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
