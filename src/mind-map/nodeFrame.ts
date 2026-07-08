import type { ConnectorSide, MindMapNode, NodeFrame } from "./types";

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface Point {
  x: number;
  y: number;
}

export const RESIZE_HANDLES: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
export const VISUAL_MIN_SIZE = 2;

export function getNodeFrame(node: MindMapNode): NodeFrame {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    autoWidth: node.autoWidth,
  };
}

export function moveFrame(frame: NodeFrame, dx: number, dy: number): NodeFrame {
  return {
    ...frame,
    x: frame.x + dx,
    y: frame.y + dy,
  };
}

export function resizeFrame(frame: NodeFrame, dx: number, dy: number, handle: ResizeHandle | undefined): NodeFrame {
  if (!handle) {
    return frame;
  }

  const next = {
    ...frame,
  };

  if (handle.includes("e")) {
    next.width = Math.max(VISUAL_MIN_SIZE, frame.width + dx);
  }

  if (handle.includes("s")) {
    next.height = Math.max(VISUAL_MIN_SIZE, frame.height + dy);
  }

  if (handle.includes("w")) {
    const width = Math.max(VISUAL_MIN_SIZE, frame.width - dx);

    next.x = frame.x + frame.width - width;
    next.width = width;
  }

  if (handle.includes("n")) {
    const height = Math.max(VISUAL_MIN_SIZE, frame.height - dy);

    next.y = frame.y + frame.height - height;
    next.height = height;
  }

  return next;
}

export function resizeChangesWidth(handle: ResizeHandle | undefined): boolean {
  return Boolean(handle?.includes("e") || handle?.includes("w"));
}

export function getEndpointPoint(frame: NodeFrame, side: ConnectorSide): Point {
  switch (side) {
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

export function isSameFrame(a: NodeFrame, b: NodeFrame): boolean {
  const autoWidthMatches = a.autoWidth === undefined || b.autoWidth === undefined || a.autoWidth === b.autoWidth;

  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && autoWidthMatches;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
