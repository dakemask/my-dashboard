import type { MindMapNode, NodeFrame } from "../domain";
import type { CanvasTextMeasurement } from "./types";

export const DEFAULT_MINIMUM_NODE_WIDTH = 32;
export const DEFAULT_MINIMUM_NODE_HEIGHT = 35;
export const DEFAULT_NODE_WIDTH = 260;
export const DEFAULT_NODE_HEIGHT = 92;
export const NODE_PADDING_X = 18;
export const NODE_PADDING_Y = 14;

export interface TextEditLayoutSource {
  readonly originalText: string;
  readonly originalFrame: NodeFrame;
  readonly originalAutoWidth: boolean;
}

export interface NodeLayoutResult {
  readonly frame: NodeFrame;
  readonly autoWidth: boolean;
}

/** Computes the committed layout for a live text edit without reading layout from the DOM. */
export function fitNodeText(
  text: string,
  element: HTMLTextAreaElement | null,
  edit: TextEditLayoutSource,
  measurement: CanvasTextMeasurement,
): NodeLayoutResult {
  const initial = measurement.measure({ element, text, width: edit.originalFrame.width });
  const firstNonEmptyEdit =
    edit.originalText.length === 0
    && edit.originalFrame.width === DEFAULT_NODE_WIDTH
    && edit.originalFrame.height === DEFAULT_NODE_HEIGHT
    && text.length > 0;
  const width = edit.originalAutoWidth
    ? initial.naturalWidth
    : firstNonEmptyEdit
      ? clamp(initial.naturalWidth, initial.minimumWidth, DEFAULT_NODE_WIDTH)
      : Math.max(initial.minimumWidth, edit.originalFrame.width);
  const measured = measurement.measure({ element, text, width });
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

/** Applies the resize settlement rules documented for the canvas. */
export function finalizeNodeResize(
  node: MindMapNode,
  draggedFrame: NodeFrame,
  element: HTMLTextAreaElement | null,
  measurement: CanvasTextMeasurement,
  minimumNodeWidth = DEFAULT_MINIMUM_NODE_WIDTH,
  minimumNodeHeight = DEFAULT_MINIMUM_NODE_HEIGHT,
): NodeLayoutResult {
  const initial = measurement.measure({ element, text: node.text, width: draggedFrame.width });
  const minimumWidth = Math.max(minimumNodeWidth, initial.minimumWidth);
  const naturalWidth = Math.max(minimumWidth, initial.naturalWidth);
  const requestedWidth = Math.max(minimumWidth, draggedFrame.width);
  const requested = requestedWidth === draggedFrame.width
    ? initial
    : measurement.measure({ element, text: node.text, width: requestedWidth });
  const autoWidth = requestedWidth > naturalWidth;
  const wrappedWidth = Math.max(minimumWidth, requested.wrappedWidth);
  const remainingWidth = requestedWidth - wrappedWidth;
  const tightenWrappedWidth = remainingWidth > 0 && remainingWidth < requested.characterWidth;
  const width = autoWidth ? naturalWidth : tightenWrappedWidth ? wrappedWidth : requestedWidth;
  const measured = measurement.measure({ element, text: node.text, width });
  return {
    frame: {
      x: draggedFrame.x,
      y: draggedFrame.y,
      width,
      height: Math.max(minimumNodeHeight, measured.minimumHeight, measured.height),
    },
    autoWidth,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
