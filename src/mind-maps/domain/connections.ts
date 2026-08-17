import type {
  ConnectorSide,
  MindMapArrow,
  MindMapEndpoint,
  MindMapNode,
} from "./types";

export const CONNECTOR_SIDES = ["top", "right", "bottom", "left"] as const satisfies readonly ConnectorSide[];

const connectorSideSet = new Set<string>(CONNECTOR_SIDES);

export interface ConnectionGraph {
  readonly nodes: readonly Pick<MindMapNode, "id">[];
  readonly arrows: readonly Pick<MindMapArrow, "from" | "to">[];
}

export type ConnectionRejection = "invalid-side" | "missing-node" | "self" | "duplicate";

export function isConnectorSide(value: unknown): value is ConnectorSide {
  return typeof value === "string" && connectorSideSet.has(value);
}

export function sameEndpoint(left: MindMapEndpoint, right: MindMapEndpoint): boolean {
  return left.nodeId === right.nodeId && left.side === right.side;
}

export function connectionKey(from: MindMapEndpoint, to: MindMapEndpoint): string {
  return `${from.nodeId}\u0000${from.side}\u0000${to.nodeId}\u0000${to.side}`;
}

export function isSelfConnection(from: MindMapEndpoint, to: MindMapEndpoint): boolean {
  return from.nodeId === to.nodeId;
}

export function hasDuplicateConnection(
  arrows: readonly Pick<MindMapArrow, "from" | "to">[],
  from: MindMapEndpoint,
  to: MindMapEndpoint,
): boolean {
  const key = connectionKey(from, to);
  return arrows.some((arrow) => connectionKey(arrow.from, arrow.to) === key);
}

export function connectionRejection(
  graph: ConnectionGraph,
  from: MindMapEndpoint,
  to: MindMapEndpoint,
): ConnectionRejection | null {
  if (!isConnectorSide(from.side) || !isConnectorSide(to.side)) return "invalid-side";
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (!nodeIds.has(from.nodeId) || !nodeIds.has(to.nodeId)) return "missing-node";
  if (isSelfConnection(from, to)) return "self";
  if (hasDuplicateConnection(graph.arrows, from, to)) return "duplicate";
  return null;
}

export function canConnect(
  graph: ConnectionGraph,
  from: MindMapEndpoint,
  to: MindMapEndpoint,
): boolean {
  return connectionRejection(graph, from, to) === null;
}
