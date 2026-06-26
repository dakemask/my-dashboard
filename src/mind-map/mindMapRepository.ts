import { loadJsonFile, saveJsonFile } from "../shared/privateData/jsonFileRepository";
import type { LoadedJsonFile, PrivateDataSettings } from "../shared/privateData/types";
import { createEmptyMindMapData, MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from "./mindMap";
import type {
  ConnectorSide,
  MindMapArrow,
  MindMapData,
  MindMapEndpoint,
  MindMapNode,
} from "./types";

const CONNECTOR_SIDES: ConnectorSide[] = ["top", "right", "bottom", "left"];

export function loadMindMapData(settings: PrivateDataSettings): Promise<LoadedJsonFile<MindMapData>> {
  return loadJsonFile(settings, normalizeMindMapData, createEmptyMindMapData);
}

export function saveMindMapData(
  settings: PrivateDataSettings,
  data: MindMapData,
  sha: string | null,
  message: string,
): Promise<string> {
  return saveJsonFile(settings, data, sha, message);
}

function normalizeMindMapData(value: unknown): MindMapData {
  if (!value || typeof value !== "object") {
    return createEmptyMindMapData();
  }

  const record = value as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map(normalizeNode).filter((node): node is MindMapNode => node !== null)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const arrows = Array.isArray(record.arrows)
    ? record.arrows
        .map((arrow) => normalizeArrow(arrow, nodeIds))
        .filter((arrow): arrow is MindMapArrow => arrow !== null)
    : [];

  return {
    nodes,
    arrows,
  };
}

function normalizeNode(value: unknown): MindMapNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const node = value as Record<string, unknown>;

  if (typeof node.id !== "string") {
    return null;
  }

  return {
    id: node.id,
    text: typeof node.text === "string" ? node.text : "",
    x: normalizeNumber(node.x, 80),
    y: normalizeNumber(node.y, 80),
    width: Math.max(MIN_NODE_WIDTH, normalizeNumber(node.width, 260)),
    height: Math.max(MIN_NODE_HEIGHT, normalizeNumber(node.height, 92)),
  };
}

function normalizeArrow(value: unknown, nodeIds: Set<string>): MindMapArrow | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const arrow = value as Record<string, unknown>;
  const from = normalizeEndpoint(arrow.from, nodeIds);
  const to = normalizeEndpoint(arrow.to, nodeIds);

  if (typeof arrow.id !== "string" || !from || !to || from.nodeId === to.nodeId) {
    return null;
  }

  return {
    id: arrow.id,
    from,
    to,
  };
}

function normalizeEndpoint(value: unknown, nodeIds: Set<string>): MindMapEndpoint | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const endpoint = value as Record<string, unknown>;

  if (
    typeof endpoint.nodeId !== "string" ||
    !nodeIds.has(endpoint.nodeId) ||
    !isConnectorSide(endpoint.side)
  ) {
    return null;
  }

  return {
    nodeId: endpoint.nodeId,
    side: endpoint.side,
  };
}

function isConnectorSide(value: unknown): value is ConnectorSide {
  return CONNECTOR_SIDES.some((side) => side === value);
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}
