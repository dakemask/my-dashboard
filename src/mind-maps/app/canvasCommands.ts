import {
  canConnect,
  type MindMapDocument,
  type MindMapEndpoint,
  type MindMapEvent,
  type MindMapNode,
  type NodeFrame,
} from "../domain";

export const DEFAULT_NODE_WIDTH = 260;
export const DEFAULT_NODE_HEIGHT = 92;

export interface CanvasSelectionPlanInput {
  readonly nodeIds: readonly string[];
  readonly arrowIds: readonly string[];
}

export interface CanvasTextPlanInput {
  readonly nodeId: string;
  readonly text: string;
  readonly frame: NodeFrame;
  readonly autoWidth: boolean;
}

export function planAddNode(
  mapId: string,
  nodeId: string,
  position: { readonly x: number; readonly y: number },
): Extract<MindMapEvent, { readonly type: "add-node" }> {
  return {
    type: "add-node",
    mapId,
    node: {
      id: nodeId,
      text: "",
      x: position.x - DEFAULT_NODE_WIDTH / 2,
      y: position.y - DEFAULT_NODE_HEIGHT / 2,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      autoWidth: false,
    },
  };
}

export function planMoveNodes(
  map: MindMapDocument,
  nodeIds: readonly string[],
  dx: number,
  dy: number,
): Extract<MindMapEvent, { readonly type: "move-nodes" }> | null {
  const selected = new Set(nodeIds);
  const positions = map.nodes
    .filter((node) => selected.has(node.id))
    .map((node) => ({ nodeId: node.id, x: node.x + dx, y: node.y + dy }));
  return positions.length > 0
    ? { type: "move-nodes", mapId: map.id, positions }
    : null;
}

export function planNodeText(
  mapId: string | null,
  change: CanvasTextPlanInput,
): Extract<MindMapEvent, { readonly type: "set-node-text" }> | null {
  return mapId ? {
    type: "set-node-text",
    mapId,
    nodeId: change.nodeId,
    text: change.text,
    frame: change.frame,
    autoWidth: change.autoWidth,
  } : null;
}

export function planNodeFrame(
  mapId: string | null,
  nodeId: string,
  frame: NodeFrame,
  autoWidth: boolean,
): Extract<MindMapEvent, { readonly type: "set-node-frame" }> | null {
  return mapId ? { type: "set-node-frame", mapId, nodeId, frame, autoWidth } : null;
}

export function planCreateArrow(
  map: MindMapDocument,
  arrowId: string,
  from: MindMapEndpoint,
  to: MindMapEndpoint,
): Extract<MindMapEvent, { readonly type: "add-arrow" }> | null {
  return canConnect(map, from, to)
    ? { type: "add-arrow", mapId: map.id, arrow: { id: arrowId, from, to } }
    : null;
}

export function planDeleteCanvasSelection(
  mapId: string | null,
  selection: CanvasSelectionPlanInput,
): Extract<MindMapEvent, { readonly type: "delete-objects" }> | null {
  if (!mapId || (selection.nodeIds.length === 0 && selection.arrowIds.length === 0)) return null;
  return {
    type: "delete-objects",
    mapId,
    nodeIds: selection.nodeIds,
    arrowIds: selection.arrowIds,
  };
}

export function mapReflectsTextChange(
  map: MindMapDocument,
  change: CanvasTextPlanInput,
): boolean {
  const node = map.nodes.find((candidate: MindMapNode) => candidate.id === change.nodeId);
  return Boolean(
    node
    && node.text === change.text
    && node.x === change.frame.x
    && node.y === change.frame.y
    && node.width === change.frame.width
    && node.height === change.frame.height
    && node.autoWidth === change.autoWidth,
  );
}
