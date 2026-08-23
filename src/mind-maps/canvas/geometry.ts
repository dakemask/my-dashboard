import type {
  ConnectorSide,
  MindMapArrow,
  MindMapBracket,
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

interface BracketGeometry {
  readonly topApproach: Point;
  readonly topCorner: Point;
  readonly topExit: Point;
  readonly bottomEntry: Point;
  readonly bottomCorner: Point;
  readonly bottomExit: Point;
  readonly center: Point;
  readonly centerTip: Point;
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

export function bracketPathData(bracket: MindMapBracket): string {
  const geometry = bracketGeometry(bracket);
  return [
    `M ${pathPoint(bracket.from)}`,
    `L ${pathPoint(geometry.topApproach)}`,
    `Q ${pathPoint(geometry.topCorner)} ${pathPoint(geometry.topExit)}`,
    `L ${pathPoint(geometry.bottomEntry)}`,
    `Q ${pathPoint(geometry.bottomCorner)} ${pathPoint(geometry.bottomExit)}`,
    `L ${pathPoint(bracket.to)}`,
    `M ${pathPoint(geometry.center)}`,
    `L ${pathPoint(geometry.centerTip)}`,
  ].join(" ");
}

export function bracketBounds(bracket: MindMapBracket): Rect {
  const geometry = bracketGeometry(bracket);
  const points = [
    bracket.from,
    bracket.to,
    geometry.topCorner,
    geometry.bottomCorner,
    geometry.centerTip,
  ];
  const margin = 5;
  const left = Math.min(...points.map((point) => point.x)) - margin;
  const top = Math.min(...points.map((point) => point.y)) - margin;
  const right = Math.max(...points.map((point) => point.x)) + margin;
  const bottom = Math.max(...points.map((point) => point.y)) + margin;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function translateBracket(
  bracket: MindMapBracket,
  dx: number,
  dy: number,
): MindMapBracket {
  return {
    ...bracket,
    from: { x: bracket.from.x + dx, y: bracket.from.y + dy },
    to: { x: bracket.to.x + dx, y: bracket.to.y + dy },
  };
}

export function moveBracketEndpoint(
  bracket: MindMapBracket,
  endpoint: "from" | "to",
  pointer: Point,
  minimumLength: number,
): MindMapBracket {
  const fixed = endpoint === "from" ? bracket.to : bracket.from;
  const original = endpoint === "from" ? bracket.from : bracket.to;
  const dx = pointer.x - fixed.x;
  const dy = pointer.y - fixed.y;
  const distance = Math.hypot(dx, dy);
  const originalDx = original.x - fixed.x;
  const originalDy = original.y - fixed.y;
  const originalDistance = Math.hypot(originalDx, originalDy);
  const scale = minimumLength / (distance || originalDistance || 1);
  const point = distance >= minimumLength
    ? pointer
    : distance > 0
      ? { x: fixed.x + dx * scale, y: fixed.y + dy * scale }
      : {
          x: fixed.x + originalDx * scale,
          y: fixed.y + originalDy * scale,
        };
  return endpoint === "from"
    ? { ...bracket, from: point }
    : { ...bracket, to: point };
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

function bracketGeometry(bracket: MindMapBracket): BracketGeometry {
  const dx = bracket.to.x - bracket.from.x;
  const dy = bracket.to.y - bracket.from.y;
  const length = Math.hypot(dx, dy) || 1;
  const along = { x: dx / length, y: dy / length };
  const outward = { x: -along.y, y: along.x };
  const depth = Math.min(24, Math.max(14, length * 0.06));
  const radius = Math.min(6, depth * 0.35, length / 4);
  const topCorner = add(bracket.from, outward, depth);
  const bottomCorner = add(bracket.to, outward, depth);
  const center = add(midpoint(bracket.from, bracket.to), outward, depth);
  return {
    topApproach: add(bracket.from, outward, depth - radius),
    topCorner,
    topExit: add(topCorner, along, radius),
    bottomEntry: add(bottomCorner, along, -radius),
    bottomCorner,
    bottomExit: add(bracket.to, outward, depth - radius),
    center,
    centerTip: add(center, outward, depth),
  };
}

function midpoint(from: Point, to: Point): Point {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

function add(origin: Point, direction: Point, distance: number): Point {
  return {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance,
  };
}

function pathPoint(point: Point): string {
  return `${point.x} ${point.y}`;
}
