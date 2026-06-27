import type {
  MindMapArrow,
  MindMapData,
  MindMapEndpoint,
  MindMapNode,
  NodeFrame,
} from "./types";

export const DEFAULT_NODE_WIDTH = 260;
export const DEFAULT_NODE_HEIGHT = 92;
export const MIN_NODE_WIDTH = 64;
export const MIN_NODE_HEIGHT = 44;

export function createEmptyMindMapData(): MindMapData {
  return {
    nodes: [],
    arrows: [],
  };
}

export function createMindMapNode(x: number, y: number, text = ""): MindMapNode {
  return {
    id: createId("node"),
    text,
    x,
    y,
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
  };
}

export function addNode(data: MindMapData, node: MindMapNode): MindMapData {
  return {
    ...data,
    nodes: [...data.nodes, node],
  };
}

export function updateNodeText(data: MindMapData, id: string, text: string, frame?: NodeFrame): MindMapData {
  return updateNode(data, id, {
    text,
    ...(frame ?? {}),
  });
}

export function updateNodeFrame(data: MindMapData, id: string, frame: NodeFrame): MindMapData {
  return updateNode(data, id, frame);
}

export function deleteNode(data: MindMapData, id: string): MindMapData {
  return {
    nodes: data.nodes.filter((node) => node.id !== id),
    arrows: data.arrows.filter((arrow) => arrow.from.nodeId !== id && arrow.to.nodeId !== id),
  };
}

export function createMindMapArrow(from: MindMapEndpoint, to: MindMapEndpoint): MindMapArrow {
  return {
    id: createId("arrow"),
    from,
    to,
  };
}

export function addArrow(data: MindMapData, arrow: MindMapArrow): MindMapData {
  if (!hasEndpointNode(data, arrow.from) || !hasEndpointNode(data, arrow.to)) {
    return data;
  }

  if (arrow.from.nodeId === arrow.to.nodeId) {
    return data;
  }

  if (hasSameArrow(data, arrow)) {
    return data;
  }

  return {
    ...data,
    arrows: [...data.arrows, arrow],
  };
}

export function deleteArrow(data: MindMapData, id: string): MindMapData {
  return {
    ...data,
    arrows: data.arrows.filter((arrow) => arrow.id !== id),
  };
}

export function findNode(data: MindMapData, id: string): MindMapNode | null {
  return data.nodes.find((node) => node.id === id) ?? null;
}

function updateNode(data: MindMapData, id: string, changes: Partial<MindMapNode>): MindMapData {
  return {
    ...data,
    nodes: data.nodes.map((node) =>
      node.id === id
        ? {
            ...node,
            ...changes,
            width: clampSize(changes.width ?? node.width, MIN_NODE_WIDTH),
            height: clampSize(changes.height ?? node.height, MIN_NODE_HEIGHT),
          }
        : node,
    ),
  };
}

function hasEndpointNode(data: MindMapData, endpoint: MindMapEndpoint): boolean {
  return data.nodes.some((node) => node.id === endpoint.nodeId);
}

function hasSameArrow(data: MindMapData, next: MindMapArrow): boolean {
  return data.arrows.some(
    (arrow) =>
      arrow.from.nodeId === next.from.nodeId &&
      arrow.from.side === next.from.side &&
      arrow.to.nodeId === next.to.nodeId &&
      arrow.to.side === next.to.side,
  );
}

function clampSize(value: number, min: number): number {
  return Math.max(min, Math.round(value));
}

function createId(prefix: string): string {
  if ("randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
