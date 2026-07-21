import { isSameOrDescendant, normalizeFolderPath, normalizeMapPath, parentPath } from "./names";
import {
  validateMindMapArrow,
  validateMindMapDocument,
  validateMindMapNode,
  validateMindMapPayload,
  validateNodeFrame,
} from "./model";
import type {
  MindMapArrow,
  MindMapDocument,
  MindMapEvent,
  MindMapNode,
  MindMapPayload,
  NodePosition,
} from "./types";

export function applyMindMapEvent(
  payloadValue: MindMapPayload,
  event: MindMapEvent,
): MindMapPayload {
  const payload = validateMindMapPayload(payloadValue);

  switch (event.type) {
    case "create-folder": {
      const path = requireNormalizedFolderPath(event.path);
      requireParentFolder(payload, path);
      return validateMindMapPayload({ ...payload, folders: [...payload.folders, path] });
    }
    case "delete-folder": {
      const path = requireExistingFolder(payload, event.path);
      return validateMindMapPayload({
        folders: payload.folders.filter((candidate) => !isSameOrDescendant(candidate, path)),
        maps: payload.maps.filter((map) => !isMapInsideFolder(map, path)),
      });
    }
    case "restore-folder": {
      const rootPath = requireNormalizedFolderPath(event.rootPath);
      if (!event.folders.includes(rootPath)) {
        throw new TypeError("A restored folder snapshot must contain its root folder.");
      }
      requireParentFolder(payload, rootPath);
      if (event.folders.some((path) => !isSameOrDescendant(path, rootPath))) {
        throw new TypeError("A restored folder snapshot contains an unrelated folder.");
      }
      if (event.maps.some((map) => !isMapInsideFolder(map, rootPath))) {
        throw new TypeError("A restored folder snapshot contains an unrelated map.");
      }
      return validateMindMapPayload({
        folders: [...payload.folders, ...event.folders],
        maps: [...payload.maps, ...event.maps],
      });
    }
    case "relocate-folder": {
      const fromPath = requireExistingFolder(payload, event.fromPath);
      const toPath = requireNormalizedFolderPath(event.toPath);
      const targetParent = parentPath(toPath);
      if (targetParent && isSameOrDescendantComparable(targetParent, fromPath)) {
        throw new TypeError("A folder cannot be moved inside itself.");
      }
      if (targetParent && !hasFolder(payload, targetParent)) {
        throw new TypeError(`Target parent folder does not exist: ${targetParent}`);
      }
      const relocateFolderPath = (path: string): string => path === fromPath
        ? toPath
        : path.startsWith(`${fromPath}/`)
          ? `${toPath}${path.slice(fromPath.length)}`
          : path;
      const relocateMapPath = (path: string): string => path.startsWith(`${fromPath}/`)
        ? `${toPath}${path.slice(fromPath.length)}`
        : path;
      return validateMindMapPayload({
        folders: payload.folders.map(relocateFolderPath),
        maps: payload.maps.map((map) => ({ ...map, path: relocateMapPath(map.path) })),
      });
    }
    case "create-map":
    case "restore-map": {
      const map = validateMindMapDocument(event.map);
      requireParentFolder(payload, map.path);
      return validateMindMapPayload({ ...payload, maps: [...payload.maps, map] });
    }
    case "delete-map": {
      requireMap(payload, event.mapId);
      return validateMindMapPayload({
        ...payload,
        maps: payload.maps.filter((map) => map.id !== event.mapId),
      });
    }
    case "relocate-map": {
      requireMap(payload, event.mapId);
      const path = requireNormalizedMapPath(event.path);
      requireParentFolder(payload, path);
      return replaceMap(payload, event.mapId, (map) => ({ ...map, path }));
    }
    case "add-node": {
      const node = validateMindMapNode(event.node);
      return replaceMap(payload, event.mapId, (map) => ({
        ...map,
        nodes: [...map.nodes, node],
      }));
    }
    case "set-node-text": {
      if (typeof event.text !== "string") throw new TypeError("Node text must be a string.");
      const frame = validateNodeFrame(event.frame);
      if (typeof event.autoWidth !== "boolean") {
        throw new TypeError("Node autoWidth must be a boolean.");
      }
      return replaceNode(payload, event.mapId, event.nodeId, (node) => ({
        ...node,
        text: event.text,
        ...frame,
        autoWidth: event.autoWidth,
      }));
    }
    case "set-node-frame": {
      const frame = validateNodeFrame(event.frame);
      if (typeof event.autoWidth !== "boolean") {
        throw new TypeError("Node autoWidth must be a boolean.");
      }
      return replaceNode(payload, event.mapId, event.nodeId, (node) => ({
        ...node,
        ...frame,
        autoWidth: event.autoWidth,
      }));
    }
    case "move-nodes": {
      const positions = validatePositions(event.positions);
      const byId = new Map(positions.map((position) => [position.nodeId, position]));
      return replaceMap(payload, event.mapId, (map) => {
        for (const nodeId of byId.keys()) requireNode(map, nodeId);
        return {
          ...map,
          nodes: map.nodes.map((node) => {
            const position = byId.get(node.id);
            return position ? { ...node, x: position.x, y: position.y } : node;
          }),
        };
      });
    }
    case "add-arrow": {
      const arrow = validateMindMapArrow(event.arrow);
      return replaceMap(payload, event.mapId, (map) => ({
        ...map,
        arrows: [...map.arrows, arrow],
      }));
    }
    case "delete-objects": {
      const nodeIds = uniqueIdentifiers(event.nodeIds, "node id");
      const arrowIds = uniqueIdentifiers(event.arrowIds, "arrow id");
      return replaceMap(payload, event.mapId, (map) => {
        for (const id of nodeIds) requireNode(map, id);
        for (const id of arrowIds) requireArrow(map, id);
        const removedNodes = new Set(nodeIds);
        const removedArrows = new Set(arrowIds);
        return {
          ...map,
          nodes: map.nodes.filter((node) => !removedNodes.has(node.id)),
          arrows: map.arrows.filter((arrow) =>
            !removedArrows.has(arrow.id)
            && !removedNodes.has(arrow.from.nodeId)
            && !removedNodes.has(arrow.to.nodeId)),
        };
      });
    }
    case "restore-objects": {
      const nodes = event.nodes.map(validateMindMapNode);
      const arrows = event.arrows.map(validateMindMapArrow);
      return replaceMap(payload, event.mapId, (map) => ({
        ...map,
        nodes: [...map.nodes, ...nodes],
        arrows: [...map.arrows, ...arrows],
      }));
    }
  }
}

export function invertMindMapEvent(
  event: MindMapEvent,
  beforeValue: MindMapPayload,
  afterValue: MindMapPayload,
): MindMapEvent {
  const before = validateMindMapPayload(beforeValue);
  const after = validateMindMapPayload(afterValue);

  switch (event.type) {
    case "create-folder":
      return { type: "delete-folder", path: event.path };
    case "delete-folder": {
      const path = requireExistingFolder(before, event.path);
      return {
        type: "restore-folder",
        rootPath: path,
        folders: before.folders.filter((folder) => isSameOrDescendant(folder, path)),
        maps: before.maps.filter((map) => isMapInsideFolder(map, path)),
      };
    }
    case "restore-folder":
      return { type: "delete-folder", path: event.rootPath };
    case "relocate-folder":
      return {
        type: "relocate-folder",
        fromPath: event.toPath,
        toPath: requireExistingFolder(before, event.fromPath),
      };
    case "create-map":
      return { type: "delete-map", mapId: event.map.id };
    case "delete-map":
      return { type: "restore-map", map: requireMap(before, event.mapId) };
    case "restore-map":
      return { type: "delete-map", mapId: event.map.id };
    case "relocate-map":
      return {
        type: "relocate-map",
        mapId: event.mapId,
        path: requireMap(before, event.mapId).path,
      };
    case "add-node":
      return {
        type: "delete-objects",
        mapId: event.mapId,
        nodeIds: [event.node.id],
        arrowIds: [],
      };
    case "set-node-text":
      {
        const node = requireNode(requireMap(before, event.mapId), event.nodeId);
        return {
          ...event,
          text: node.text,
          frame: { x: node.x, y: node.y, width: node.width, height: node.height },
          autoWidth: node.autoWidth,
        };
      }
    case "set-node-frame": {
      const node = requireNode(requireMap(before, event.mapId), event.nodeId);
      return {
        ...event,
        frame: { x: node.x, y: node.y, width: node.width, height: node.height },
        autoWidth: node.autoWidth,
      };
    }
    case "move-nodes": {
      const map = requireMap(before, event.mapId);
      return {
        ...event,
        positions: event.positions.map(({ nodeId }) => {
          const node = requireNode(map, nodeId);
          return { nodeId, x: node.x, y: node.y };
        }),
      };
    }
    case "add-arrow":
      return {
        type: "delete-objects",
        mapId: event.mapId,
        nodeIds: [],
        arrowIds: [event.arrow.id],
      };
    case "delete-objects": {
      const beforeMap = requireMap(before, event.mapId);
      const afterMap = requireMap(after, event.mapId);
      const remainingNodeIds = new Set(afterMap.nodes.map((node) => node.id));
      const remainingArrowIds = new Set(afterMap.arrows.map((arrow) => arrow.id));
      return {
        type: "restore-objects",
        mapId: event.mapId,
        nodes: beforeMap.nodes.filter((node) => !remainingNodeIds.has(node.id)),
        arrows: beforeMap.arrows.filter((arrow) => !remainingArrowIds.has(arrow.id)),
      };
    }
    case "restore-objects":
      return {
        type: "delete-objects",
        mapId: event.mapId,
        nodeIds: event.nodes.map((node) => node.id),
        arrowIds: event.arrows.map((arrow) => arrow.id),
      };
  }
}

function replaceMap(
  payload: MindMapPayload,
  mapId: string,
  update: (map: MindMapDocument) => MindMapDocument,
): MindMapPayload {
  requireMap(payload, mapId);
  return validateMindMapPayload({
    ...payload,
    maps: payload.maps.map((map) => map.id === mapId ? update(map) : map),
  });
}

function replaceNode(
  payload: MindMapPayload,
  mapId: string,
  nodeId: string,
  update: (node: MindMapNode) => MindMapNode,
): MindMapPayload {
  return replaceMap(payload, mapId, (map) => {
    requireNode(map, nodeId);
    return {
      ...map,
      nodes: map.nodes.map((node) => node.id === nodeId ? update(node) : node),
    };
  });
}

function requireMap(payload: MindMapPayload, mapId: string): MindMapDocument {
  const map = payload.maps.find((candidate) => candidate.id === mapId);
  if (!map) throw new TypeError(`Map does not exist: ${mapId}`);
  return map;
}

function isMapInsideFolder(map: MindMapDocument, folderPath: string): boolean {
  return isSameOrDescendant(parentPath(map.path), folderPath);
}

function requireNode(map: MindMapDocument, nodeId: string): MindMapNode {
  const node = map.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new TypeError(`Node does not exist: ${nodeId}`);
  return node;
}

function requireArrow(map: MindMapDocument, arrowId: string): MindMapArrow {
  const arrow = map.arrows.find((candidate) => candidate.id === arrowId);
  if (!arrow) throw new TypeError(`Arrow does not exist: ${arrowId}`);
  return arrow;
}

function requireExistingFolder(payload: MindMapPayload, value: string): string {
  const path = requireNormalizedFolderPath(value);
  if (!hasFolder(payload, path)) throw new TypeError(`Folder does not exist: ${path}`);
  return payload.folders.find((folder) => comparablePath(folder) === comparablePath(path))!;
}

function requireParentFolder(payload: MindMapPayload, path: string): void {
  const parent = parentPath(path);
  if (parent && !hasFolder(payload, parent)) {
    throw new TypeError(`Parent folder does not exist: ${parent}`);
  }
}

function hasFolder(payload: MindMapPayload, path: string): boolean {
  const key = comparablePath(path);
  return payload.folders.some((folder) => comparablePath(folder) === key);
}

function requireNormalizedFolderPath(value: string): string {
  const normalized = normalizeFolderPath(value);
  if (normalized !== value) throw new TypeError(`Folder path is not normalized: ${value}`);
  return value;
}

function requireNormalizedMapPath(value: string): string {
  const normalized = normalizeMapPath(value);
  if (normalized !== value) throw new TypeError(`Map path is not normalized: ${value}`);
  return value;
}

function comparablePath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("und");
}

function isSameOrDescendantComparable(path: string, ancestor: string): boolean {
  const pathKey = comparablePath(path);
  const ancestorKey = comparablePath(ancestor);
  return pathKey === ancestorKey || pathKey.startsWith(`${ancestorKey}/`);
}

function validatePositions(values: readonly NodePosition[]): readonly NodePosition[] {
  if (!Array.isArray(values)) throw new TypeError("Node positions must be an array.");
  const ids = new Set<string>();
  return values.map((position) => {
    if (!position || typeof position !== "object") {
      throw new TypeError("A node position must be an object.");
    }
    const nodeId = requireEventIdentifier(position.nodeId, "node id");
    if (ids.has(nodeId)) throw new TypeError(`Duplicate node position: ${nodeId}`);
    ids.add(nodeId);
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new TypeError("Node positions must be finite.");
    }
    return { nodeId, x: position.x, y: position.y };
  });
}

function uniqueIdentifiers(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label}s must be an array.`);
  const result = values.map((value) => requireEventIdentifier(value, label));
  if (new Set(result).size !== result.length) throw new TypeError(`Duplicate ${label}.`);
  return result;
}

function requireEventIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}
