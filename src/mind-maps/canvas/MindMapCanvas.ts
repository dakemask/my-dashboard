import type { MindMapDocument, MindMapEndpoint, MindMapNode, NodeFrame } from "../domain";
import { CONNECTOR_SIDES, canConnect } from "../domain";
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
import { BrowserTextMeasurement } from "./browserTextMeasurement";
import {
  CanvasInteractionController,
  type MutableCanvasSelection,
  type PointerInteraction,
  usesAutoPan,
} from "./interactionController";
import {
  DEFAULT_MINIMUM_NODE_HEIGHT,
  DEFAULT_MINIMUM_NODE_WIDTH,
  finalizeNodeResize,
  fitNodeText,
} from "./nodeLayout";
import { CanvasTextEditor, framesEqual, type CanvasEditingState } from "./textEditor";
import {
  MindMapSvgRenderer,
  type CanvasRendererProjection,
} from "./svgRenderer";
import type {
  CanvasMeasurements,
  CanvasSelection,
  CanvasTextChange,
  CanvasTextCommitMode,
  CanvasTextMeasurement,
  MindMapCanvasCallbacks,
  MindMapCanvasOptions,
  PointerCaptureAdapter,
} from "./types";
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

export type {
  CanvasMeasurements,
  CanvasSelection,
  CanvasTextChange,
  CanvasTextCommitMode,
  CanvasTextCommitResult,
  CanvasTextMeasureInput,
  CanvasTextMeasurement,
  CanvasTextMetrics,
  MindMapCanvasCallbacks,
  MindMapCanvasOptions,
  PointerCaptureAdapter,
} from "./types";

const DEFAULT_CONNECTOR_HIT_RADIUS = 18;
const RESIZE_PREVIEW_MINIMUM_SIZE = 2;
const RESIZE_PREVIEW_MOVE_EPSILON = 2;
const MOVE_DRAG_THRESHOLD = 4;

interface TextCommitResult {
  readonly change: CanvasTextChange | null;
  readonly accepted: boolean;
}

export class MindMapCanvas {
  readonly #ownerDocument: Document;
  readonly #callbacks: MindMapCanvasCallbacks;
  readonly #measurements: CanvasMeasurements;
  readonly #textMeasurement: CanvasTextMeasurement;
  readonly #minimumNodeWidth: number;
  readonly #minimumNodeHeight: number;
  readonly #connectorHitRadiusSquared: number;
  readonly #renderer: MindMapSvgRenderer;
  readonly #svg: SVGSVGElement;
  readonly #viewportsByDocumentId = new Map<string, CanvasViewport>();
  readonly #frameOverrides = new Map<string, NodeFrame>();
  readonly #textEditor = new CanvasTextEditor();
  readonly #interactions: CanvasInteractionController;

  #map: MindMapDocument | null = null;
  #viewport: CanvasViewport = { ...IDENTITY_VIEWPORT };
  #selection: MutableCanvasSelection = emptySelection();
  #arrowMode = false;
  #destroyed = false;

  constructor(host: HTMLElement, options: MindMapCanvasOptions = {}) {
    this.#ownerDocument = host.ownerDocument;
    this.#callbacks = options.callbacks ?? {};
    this.#measurements = options.measurements ?? defaultMeasurements();
    this.#textMeasurement = options.textMeasurement ?? new BrowserTextMeasurement(this.#ownerDocument);
    this.#minimumNodeWidth = positive(options.minimumNodeWidth, DEFAULT_MINIMUM_NODE_WIDTH);
    this.#minimumNodeHeight = positive(options.minimumNodeHeight, DEFAULT_MINIMUM_NODE_HEIGHT);
    const connectorHitRadius = positive(options.connectorHitRadius, DEFAULT_CONNECTOR_HIT_RADIUS);
    this.#connectorHitRadiusSquared = connectorHitRadius * connectorHitRadius;
    this.#renderer = new MindMapSvgRenderer(this.#ownerDocument, {
      onArrowPointerDown: (event, arrowId) => this.#selectArrow(event, arrowId),
      onTextPointerDown: (event, nodeId, textarea) => {
        this.#handleTextPointerDown(event, nodeId, textarea);
      },
      onTextClick: (event, nodeId) => {
        if (!event.ctrlKey && !this.#arrowMode && this.#editing?.nodeId !== nodeId) {
          this.editNode(nodeId);
        }
      },
      onTextBlur: (nodeId) => {
        if (this.#editing?.nodeId === nodeId) this.commitActiveTextEdit();
      },
      onTextInput: (nodeId) => this.#previewTextEdit(nodeId),
      onNodeMovePointerDown: (event, nodeId) => this.#beginNodeMove(event, nodeId),
      onResizePointerDown: (event, nodeId) => this.#beginResize(event, nodeId),
      onConnectorPointerDown: (event, endpoint) => this.#beginConnectorDrag(event, endpoint),
    });
    this.#svg = this.#renderer.element;
    host.replaceChildren(this.#svg);

    this.#interactions = new CanvasInteractionController({
      svg: this.#svg,
      pointerCapture: options.pointerCapture ?? defaultPointerCapture(),
      getBounds: () => this.#visibleCanvasRect(),
      onAutoPan: (delta) => this.#applyAutoPan(delta),
      animationFrames: options.animationFrames,
    });

    this.#svg.addEventListener("pointerdown", this.#onRootPointerDown);
    this.#svg.addEventListener("pointermove", this.#onPointerMove);
    this.#svg.addEventListener("pointerup", this.#onPointerUp);
    this.#svg.addEventListener("pointercancel", this.#onPointerCancel);
    this.#svg.addEventListener("lostpointercapture", this.#onLostPointerCapture);
    this.#svg.addEventListener("wheel", this.#onWheel, { passive: false });
    this.#svg.addEventListener("contextmenu", this.#onContextMenu);
    this.#applyViewport();
  }

  get #interaction(): PointerInteraction {
    return this.#interactions.current;
  }

  get #editing(): CanvasEditingState | null {
    return this.#textEditor.state;
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

    this.#cancelPointerInteraction();
    this.#discardTextEdit();
    this.#setArrowModeState(false);
    if (previousId !== map?.id) {
      this.#renderer.clear();
    }
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
    const nextSelection: MutableCanvasSelection = {
      nodeIds: new Set([...this.#selection.nodeIds].filter((id) => nodeIds.has(id))),
      arrowIds: new Set([...this.#selection.arrowIds].filter((id) => arrowIds.has(id))),
    };
    const selectionChanged = !selectionsEqual(this.#selection, nextSelection);
    this.#selection = nextSelection;
    if (this.#editing && !nodeIds.has(this.#editing.nodeId)) this.#textEditor.discard();
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
    this.#cancelPointerInteraction();
    this.#setArrowModeState(false);
    this.#selection = emptySelection();
    this.#render();
    this.#emitSelection();
    return textChange;
  }

  hasPendingTextChange(): boolean {
    this.#assertAlive();
    return this.#textEditor.hasPending((nodeId) => this.#findTextarea(nodeId)?.value ?? null);
  }

  cancelLiveInteraction(): void {
    this.#assertAlive();
    this.#cancelPointerInteraction();
    this.#discardTextEdit();
    this.#setArrowModeState(false);
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
    this.#cancelPointerInteraction();
    this.#setArrowModeState(false);
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
    this.#cancelPointerInteraction();
    this.#setArrowModeState(false);
    this.#selection = { nodeIds: new Set([nodeId]), arrowIds: new Set() };
    const frame = this.#effectiveFrame(node);
    this.#textEditor.begin(node, frame);
    this.#render();
    this.#emitSelection();
    this.#focusEditor(nodeId, true);
  }

  setArrowMode(enabled: boolean): void {
    this.#assertAlive();
    if (enabled === this.#arrowMode && this.#interaction.kind !== "connecting") return;
    this.commitActiveTextEdit();
    this.#cancelPointerInteraction();
    this.#setArrowModeState(enabled && this.#map !== null);
    this.#selection = emptySelection();
    this.#render();
    this.#emitSelection();
  }

  toggleArrowMode(): void {
    this.setArrowMode(!this.#arrowMode);
  }

  #setArrowModeState(enabled: boolean): void {
    if (enabled === this.#arrowMode) return;
    this.#arrowMode = enabled;
    this.#callbacks.onArrowModeChange?.(enabled);
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
    this.#setArrowModeState(false);
    this.#interactions.destroy();
    this.#frameOverrides.clear();
    this.#discardTextEdit();
    this.#svg.removeEventListener("pointerdown", this.#onRootPointerDown);
    this.#svg.removeEventListener("pointermove", this.#onPointerMove);
    this.#svg.removeEventListener("pointerup", this.#onPointerUp);
    this.#svg.removeEventListener("pointercancel", this.#onPointerCancel);
    this.#svg.removeEventListener("lostpointercapture", this.#onLostPointerCapture);
    this.#svg.removeEventListener("wheel", this.#onWheel);
    this.#svg.removeEventListener("contextmenu", this.#onContextMenu);
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
    const interaction = this.#interactions.update(pointerId(event), eventPoint(event));
    if (!interaction) return;
    event.preventDefault();
    this.#updatePointerInteraction();
  };

  readonly #onPointerUp = (event: PointerEvent): void => {
    const interaction = this.#interactions.update(pointerId(event), eventPoint(event));
    if (!interaction) return;
    event.preventDefault();
    this.#updatePointerInteraction();
    this.#finishPointerInteraction();
  };

  readonly #onPointerCancel = (event: PointerEvent): void => {
    this.#cancelCapturedPointer(pointerId(event));
  };

  readonly #onLostPointerCapture = (event: PointerEvent): void => {
    this.#cancelCapturedPointer(pointerId(event));
  };

  #cancelCapturedPointer(pointerIdToCancel: number): void {
    const interaction = this.#interaction;
    if (interaction.kind === "idle" || pointerIdToCancel !== interaction.pointerId) return;
    if (interaction.kind === "marquee") this.#selection = cloneSelection(interaction.baseline);
    if (interaction.kind === "connecting") this.#setArrowModeState(false);
    this.#cancelPointerInteraction();
    this.#render();
    this.#emitSelection();
  }

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

  #beginNodeMove(event: PointerEvent, nodeId: string): void {
    if (event.button !== 0 || this.#arrowMode) return;
    event.preventDefault();
    event.stopPropagation();
    this.commitActiveTextEdit();

    const toggleOnClickNodeId = event.ctrlKey && this.#selection.nodeIds.has(nodeId)
      ? nodeId
      : null;
    if (event.ctrlKey && !this.#selection.nodeIds.has(nodeId)) {
      const next = cloneSelection(this.#selection);
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
      startClient: client,
      currentWorld: this.#toWorld(client),
      lastClient: client,
      nodeIds,
      startFrames,
      toggleOnClickNodeId,
      moved: false,
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

    this.#cancelPointerInteraction();
    const node = this.#findNode(nodeId);
    if (!node || !textarea.isConnected) return;
    this.#selection = { nodeIds: new Set([nodeId]), arrowIds: new Set() };
    const frame = this.#effectiveFrame(node);
    this.#textEditor.begin(node, frame);
    this.#syncInteractionChromeInPlace();
    this.#emitSelection();
  }

  #beginPointerInteraction(interaction: Exclude<PointerInteraction, { kind: "idle" }>): void {
    this.#cancelPointerInteraction();
    this.#interactions.begin(interaction);
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
      this.#updateSelectionChrome();
      this.#renderInteractionOverlay();
      this.#emitSelection();
      return;
    }
    if (interaction.kind === "moving") {
      interaction.currentWorld = world;
      interaction.moved ||= squaredDistance(interaction.lastClient, interaction.startClient)
        > MOVE_DRAG_THRESHOLD * MOVE_DRAG_THRESHOLD;
      if (!interaction.moved) return;
      const dx = world.x - interaction.startWorld.x;
      const dy = world.y - interaction.startWorld.y;
      for (const [id, frame] of interaction.startFrames) {
        this.#frameOverrides.set(id, translateFrame(frame, dx, dy));
        this.#updateNodePreview(id);
      }
      this.#updateArrowsForNodeIds(interaction.nodeIds);
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
      this.#updateNodePreview(interaction.nodeId);
      this.#updateArrowsForNodeIds([interaction.nodeId]);
      return;
    }
    interaction.currentWorld = world;
    const previousTarget = interaction.target;
    interaction.target = this.#findConnectorAtClient(interaction.lastClient, interaction.from);
    this.#updateConnectorChrome([
      interaction.from.nodeId,
      ...(previousTarget ? [previousTarget.nodeId] : []),
      ...(interaction.target ? [interaction.target.nodeId] : []),
    ]);
    this.#renderInteractionOverlay();
  }

  #finishPointerInteraction(): void {
    const interaction = this.#interactions.finish();
    if (!interaction) return;
    let selectionChanged = false;

    if (interaction.kind === "moving") {
      if (interaction.toggleOnClickNodeId && !interaction.moved) {
        const next = cloneSelection(this.#selection);
        next.nodeIds.delete(interaction.toggleOnClickNodeId);
        this.#selection = next;
        selectionChanged = true;
      } else if (interaction.moved) {
        const dx = interaction.currentWorld.x - interaction.startWorld.x;
        const dy = interaction.currentWorld.y - interaction.startWorld.y;
        if (dx !== 0 || dy !== 0) {
          this.#callbacks.onMoveNodes?.({ nodeIds: interaction.nodeIds, dx, dy });
        }
      }
    } else if (interaction.kind === "resizing") {
      const node = this.#findNode(interaction.nodeId);
      const finalized = node
        ? finalizeNodeResize(
            node,
            interaction.currentFrame,
            this.#findTextarea(node.id),
            this.#textMeasurement,
            this.#minimumNodeWidth,
            this.#minimumNodeHeight,
          )
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
      this.#setArrowModeState(false);
      this.#selection = emptySelection();
      if (target) this.#callbacks.onCreateArrow?.({ from: interaction.from, to: target });
      this.#emitSelection();
    }

    this.#frameOverrides.clear();
    this.#render();
    if (selectionChanged) this.#emitSelection();
  }

  #cancelPointerInteraction(): void {
    const interaction = this.#interactions.cancel();
    if (!interaction) return;
    this.#frameOverrides.clear();
  }

  #takeTextChange(): CanvasTextChange | null {
    const editing = this.#editing;
    if (!editing) return null;
    const change = this.#textEditor.take(
      (nodeId) => this.#findTextarea(nodeId)?.value ?? null,
    );
    this.#frameOverrides.delete(editing.nodeId);
    return change;
  }

  #discardTextEdit(): void {
    const editing = this.#textEditor.discard();
    if (editing) this.#frameOverrides.delete(editing.nodeId);
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

  #restoreTextEdit(editing: CanvasEditingState, text: string): void {
    this.#textEditor.restore(editing);
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
    const fitted = fitNodeText(text, textarea, editing, this.#textMeasurement);
    this.#textEditor.updateLayout(fitted.frame, fitted.autoWidth);
    this.#frameOverrides.set(nodeId, fitted.frame);
    this.#applyEditingFrameToDom(nodeId, fitted.frame);
    this.#renderArrowsOnly();
  }

  #applyEditingFrameToDom(nodeId: string, frame: NodeFrame): void {
    this.#renderer.applyEditingFrame(nodeId, frame);
  }

  #selectionInside(rect: Rect): MutableCanvasSelection {
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
    const map = this.#map;
    if (!map || !canConnect(map, from, to)) return false;
    return this.#callbacks.isArrowTargetValid?.(from, to) ?? true;
  }

  #applyAutoPan(delta: Point): void {
    if (!usesAutoPan(this.#interaction)) return;
    this.#setViewport(panViewport(this.#viewport, delta), true);
    this.#updatePointerInteraction();
  }

  #setSelection(selection: MutableCanvasSelection): void {
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
    this.#renderer.setViewport(this.#viewport);
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
    return this.#renderer.findTextarea(nodeId);
  }

  #render(): void {
    if (this.#destroyed) return;
    this.#renderer.render(this.#map, this.#rendererProjection());
  }

  #rendererProjection(): CanvasRendererProjection {
    return {
      arrowMode: this.#arrowMode,
      selectedNodeIds: this.#selection.nodeIds,
      selectedArrowIds: this.#selection.arrowIds,
      interaction: this.#interaction,
      editingNodeId: this.#editing?.nodeId ?? null,
      frameForNode: (node) => this.#effectiveFrame(node),
    };
  }

  #updateSelectionChrome(): void {
    const map = this.#map;
    if (map) this.#renderer.updateSelectionChrome(map, this.#rendererProjection());
  }

  #updateNodePreview(nodeId: string): void {
    const map = this.#map;
    if (map) this.#renderer.updateNodePreview(map, nodeId, this.#rendererProjection());
  }

  #updateArrowsForNodeIds(nodeIds: readonly string[]): void {
    const map = this.#map;
    if (map) this.#renderer.updateArrowsForNodeIds(map, nodeIds, this.#rendererProjection());
  }

  #updateConnectorChrome(nodeIds: readonly string[]): void {
    const map = this.#map;
    if (map) this.#renderer.updateConnectorChrome(map, nodeIds, this.#rendererProjection());
  }

  #syncInteractionChromeInPlace(): void {
    const map = this.#map;
    if (map) this.#renderer.syncInteractionChrome(map, this.#rendererProjection());
    // Re-inserting a node group here can break the native caret/selection gesture
    // that is still being established for this pointerdown. The next full render
    // restores rank order without replacing the active pointer target mid-gesture.
  }

  #renderArrowsOnly(nodes?: ReadonlyMap<string, MindMapNode>): void {
    const map = this.#map;
    if (map) this.#renderer.renderArrows(map, this.#rendererProjection(), nodes);
  }

  #renderInteractionOverlay(): void {
    const map = this.#map;
    if (map) this.#renderer.renderOverlay(map, this.#rendererProjection());
  }

  #isBlankTarget(target: EventTarget | null): boolean {
    return this.#renderer.isBlankTarget(target);
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

function emptySelection(): MutableCanvasSelection {
  return { nodeIds: new Set(), arrowIds: new Set() };
}

function cloneSelection(selection: MutableCanvasSelection): MutableCanvasSelection {
  return { nodeIds: new Set(selection.nodeIds), arrowIds: new Set(selection.arrowIds) };
}

function selectionSnapshot(selection: MutableCanvasSelection): CanvasSelection {
  return {
    nodeIds: [...selection.nodeIds].sort(),
    arrowIds: [...selection.arrowIds].sort(),
  };
}

function toggleSelection(
  baseline: MutableCanvasSelection,
  candidates: MutableCanvasSelection,
): MutableCanvasSelection {
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

function selectionsEqual(left: MutableCanvasSelection, right: MutableCanvasSelection): boolean {
  return setsEqual(left.nodeIds, right.nodeIds) && setsEqual(left.arrowIds, right.arrowIds);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
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

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
