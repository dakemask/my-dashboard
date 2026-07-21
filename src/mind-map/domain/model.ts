import {
  compareLogicalPaths,
  normalizeFolderPath,
  normalizeMapPath,
  parentPath,
} from "./names";
import type {
  ConnectorSide,
  MindMapArrow,
  MindMapDocument,
  MindMapEndpoint,
  MindMapNode,
  MindMapPayload,
  NodeFrame,
} from "./types";

const connectorSides = new Set<ConnectorSide>(["top", "right", "bottom", "left"]);

export function createEmptyMindMapPayload(): MindMapPayload {
  return { folders: [], maps: [] };
}

/** Validates every invariant and returns a detached, deterministically ordered payload. */
export function validateMindMapPayload(value: unknown): MindMapPayload {
  const record = requireExactRecord(value, ["folders", "maps"], "Mind Map payload");
  if (!Array.isArray(record.folders) || !Array.isArray(record.maps)) {
    throw new TypeError("Mind Map payload folders and maps must be arrays.");
  }

  const folders = record.folders.map((folder, index) => {
    if (typeof folder !== "string" || normalizeFolderPath(folder) !== folder) {
      throw new TypeError(`Folder path at index ${index} is not normalized.`);
    }
    return folder;
  });
  assertUnique(folders.map(comparablePath), "folder path");
  const exactFolders = new Set(folders);

  for (const folder of folders) {
    const parent = parentPath(folder);
    if (parent && !exactFolders.has(parent)) {
      throw new TypeError(`Folder parent is missing: ${folder}`);
    }
  }

  const maps = record.maps.map((map, index) => validateDocument(map, index));
  assertUnique(maps.map((map) => map.id), "map id");
  assertUnique(maps.map((map) => comparablePath(map.path)), "map path");

  for (const map of maps) {
    const parent = parentPath(map.path);
    if (parent && !exactFolders.has(parent)) {
      throw new TypeError(`Map parent is missing: ${map.path}`);
    }
    // This relative path is reserved by the Shared repository manifest.
    if (map.path.toLocaleLowerCase("en-US") === "revision") {
      throw new TypeError("A root map cannot be named revision.");
    }
  }

  return {
    folders: [...folders].sort(compareLogicalPaths),
    maps: [...maps].sort(compareDocuments),
  };
}

export function validateMindMapDocument(value: unknown): MindMapDocument {
  return validateDocument(value);
}

export function validateMindMapNode(value: unknown): MindMapNode {
  const record = requireExactRecord(
    value,
    ["id", "text", "x", "y", "width", "height", "autoWidth"],
    "node",
  );
  const id = requireIdentifier(record.id, "node id");
  if (typeof record.text !== "string") throw new TypeError("Node text must be a string.");
  const frame = validateFrameFields(record);
  if (typeof record.autoWidth !== "boolean") {
    throw new TypeError("Node autoWidth must be a boolean.");
  }
  return { id, text: record.text, ...frame, autoWidth: record.autoWidth };
}

export function validateNodeFrame(value: unknown): NodeFrame {
  const record = requireExactRecord(value, ["x", "y", "width", "height"], "node frame");
  return validateFrameFields(record);
}

function validateFrameFields(record: Record<string, unknown>): NodeFrame {
  const x = requireFiniteNumber(record.x, "frame x");
  const y = requireFiniteNumber(record.y, "frame y");
  const width = requirePositiveNumber(record.width, "frame width");
  const height = requirePositiveNumber(record.height, "frame height");
  return { x, y, width, height };
}

export function validateMindMapArrow(value: unknown): MindMapArrow {
  const record = requireExactRecord(value, ["id", "from", "to"], "arrow");
  return {
    id: requireIdentifier(record.id, "arrow id"),
    from: validateEndpoint(record.from, "arrow from"),
    to: validateEndpoint(record.to, "arrow to"),
  };
}

function validateDocument(value: unknown, index?: number): MindMapDocument {
  const label = index === undefined ? "map" : `map at index ${index}`;
  const record = requireExactRecord(value, ["id", "path", "nodes", "arrows"], label);
  const id = requireIdentifier(record.id, "map id");
  if (typeof record.path !== "string" || normalizeMapPath(record.path) !== record.path) {
    throw new TypeError(`Map path is not normalized: ${String(record.path)}`);
  }
  if (!Array.isArray(record.nodes) || !Array.isArray(record.arrows)) {
    throw new TypeError("Map nodes and arrows must be arrays.");
  }

  const nodes = record.nodes.map(validateMindMapNode);
  const arrows = record.arrows.map(validateMindMapArrow);
  assertUnique(nodes.map((node) => node.id), "node id");
  assertUnique(arrows.map((arrow) => arrow.id), "arrow id");
  const nodeIds = new Set(nodes.map((node) => node.id));
  const connections = new Set<string>();

  for (const arrow of arrows) {
    if (!nodeIds.has(arrow.from.nodeId) || !nodeIds.has(arrow.to.nodeId)) {
      throw new TypeError(`Arrow ${arrow.id} refers to a missing node.`);
    }
    if (arrow.from.nodeId === arrow.to.nodeId) {
      throw new TypeError(`Arrow ${arrow.id} cannot connect a node to itself.`);
    }
    const key = endpointKey(arrow.from, arrow.to);
    if (connections.has(key)) {
      throw new TypeError("Completely duplicate arrow connections are not allowed.");
    }
    connections.add(key);
  }

  return {
    id,
    path: record.path,
    nodes: [...nodes].sort(compareIds),
    arrows: [...arrows].sort(compareIds),
  };
}

function validateEndpoint(value: unknown, label: string): MindMapEndpoint {
  const record = requireExactRecord(value, ["nodeId", "side"], label);
  const nodeId = requireIdentifier(record.nodeId, `${label} nodeId`);
  if (typeof record.side !== "string" || !connectorSides.has(record.side as ConnectorSide)) {
    throw new TypeError(`${label} side is invalid.`);
  }
  return { nodeId, side: record.side as ConnectorSide };
}

function endpointKey(from: MindMapEndpoint, to: MindMapEndpoint): string {
  return `${from.nodeId}\u0000${from.side}\u0000${to.nodeId}\u0000${to.side}`;
}

function comparablePath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("und");
}

function compareDocuments(left: MindMapDocument, right: MindMapDocument): number {
  return compareLogicalPaths(left.path, right.path) || compareStrings(left.id, right.id);
}

function compareIds<T extends { readonly id: string }>(left: T, right: T): number {
  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(`${label} has unexpected or missing properties.`);
  }
  return record;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} must be a normalized non-empty string.`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function requirePositiveNumber(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number <= 0) throw new TypeError(`${label} must be positive.`);
  return number;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}
