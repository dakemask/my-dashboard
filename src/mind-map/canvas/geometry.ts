import type {
  ConnectorSide,
  MindMapArrow,
  MindMapEndpoint,
  MindMapNode,
  NodeFrame,
} from "../domain";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Line {
  readonly from: Point;
  readonly to: Point;
}

export function nodeFrame(node: MindMapNode): NodeFrame {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  };
}

export function normalizeRect(from: Point, to: Point): Rect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return {
    x,
    y,
    width: Math.max(from.x, to.x) - x,
    height: Math.max(from.y, to.y) - y,
  };
}

export function rectContainsPoint(container: Rect, point: Point): boolean {
  return (
    point.x >= container.x &&
    point.x <= container.x + container.width &&
    point.y >= container.y &&
    point.y <= container.y + container.height
  );
}

export function rectFullyContainsRect(container: Rect, candidate: Rect): boolean {
  return (
    candidate.x >= container.x &&
    candidate.y >= container.y &&
    candidate.x + candidate.width <= container.x + container.width &&
    candidate.y + candidate.height <= container.y + container.height
  );
}

/** A straight segment is inside a convex rectangle exactly when both endpoints are inside it. */
export function rectFullyContainsLine(container: Rect, line: Line): boolean {
  return rectContainsPoint(container, line.from) && rectContainsPoint(container, line.to);
}

export function connectorMidpoint(frame: NodeFrame, side: ConnectorSide): Point {
  switch (side) {
    case "top":
      return { x: frame.x + frame.width / 2, y: frame.y };
    case "right":
      return { x: frame.x + frame.width, y: frame.y + frame.height / 2 };
    case "bottom":
      return { x: frame.x + frame.width / 2, y: frame.y + frame.height };
    case "left":
      return { x: frame.x, y: frame.y + frame.height / 2 };
  }
}

export function endpointPoint(
  endpoint: MindMapEndpoint,
  nodes: ReadonlyMap<string, MindMapNode>,
  frameForNode: (node: MindMapNode) => NodeFrame = nodeFrame,
): Point | null {
  const node = nodes.get(endpoint.nodeId);
  return node ? connectorMidpoint(frameForNode(node), endpoint.side) : null;
}

export function arrowLine(
  arrow: MindMapArrow,
  nodes: ReadonlyMap<string, MindMapNode>,
  frameForNode: (node: MindMapNode) => NodeFrame = nodeFrame,
): Line | null {
  const from = endpointPoint(arrow.from, nodes, frameForNode);
  const to = endpointPoint(arrow.to, nodes, frameForNode);
  return from && to ? { from, to } : null;
}

export function boundsOfFrames(frames: readonly NodeFrame[]): Rect | null {
  if (frames.length === 0) return null;

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const frame of frames) {
    left = Math.min(left, frame.x);
    top = Math.min(top, frame.y);
    right = Math.max(right, frame.x + frame.width);
    bottom = Math.max(bottom, frame.y + frame.height);
  }

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function translateFrame(frame: NodeFrame, dx: number, dy: number): NodeFrame {
  return {
    ...frame,
    x: frame.x + dx,
    y: frame.y + dy,
  };
}

export function resizeFrameFromSouthEast(
  frame: NodeFrame,
  pointer: Point,
  minimumWidth: number,
  minimumHeight: number,
): NodeFrame {
  return {
    x: frame.x,
    y: frame.y,
    width: Math.max(minimumWidth, pointer.x - frame.x),
    height: Math.max(minimumHeight, pointer.y - frame.y),
  };
}

export function squaredDistance(left: Point, right: Point): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}
