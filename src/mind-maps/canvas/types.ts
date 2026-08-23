import type {
  MindMapBracket,
  MindMapDocument,
  MindMapEndpoint,
  NodeFrame,
} from "../domain";
import type { AnimationFrameScheduler } from "./autoPan";
import type { Point } from "./geometry";
import type { CanvasViewport, ClientRectLike } from "./viewport";

export interface CanvasSelection {
  readonly nodeIds: readonly string[];
  readonly bracketIds: readonly string[];
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
  onAddBracketRequest?(command: { readonly position: Point }): void;
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
  onSetBracket?(command: { readonly bracket: MindMapBracket }): void;
  onChangeNodeText?(
    command: CanvasTextChange,
    mode: CanvasTextCommitMode,
  ): CanvasTextCommitResult | void;
  onCreateArrow?(command: {
    readonly from: MindMapEndpoint;
    readonly to: MindMapEndpoint;
  }): void;
  /** @deprecated Delete routing belongs to the page command router. */
  onDeleteSelection?(selection: CanvasSelection): void;
  onArrowModeChange?(enabled: boolean): void;
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
  readonly wrappedWidth: number;
  readonly characterWidth: number;
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
