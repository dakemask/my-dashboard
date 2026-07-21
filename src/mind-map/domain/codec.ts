import { parentPath } from "./names";
import { validateMindMapPayload } from "./model";
import type { MindMapDocument, MindMapPayload } from "./types";

const KEEP_FILE = ".gitkeep";
const JSON_SUFFIX = ".json";

interface StoredMapDocument {
  readonly id: string;
  readonly nodes: MindMapDocument["nodes"];
  readonly arrows: MindMapDocument["arrows"];
}

export function encodeMindMapPayload(payloadValue: MindMapPayload): ReadonlyMap<string, string> {
  const payload = validateMindMapPayload(payloadValue);
  const files = new Map<string, string>();

  for (const map of payload.maps) {
    const stored: StoredMapDocument = {
      id: map.id,
      nodes: map.nodes,
      arrows: map.arrows,
    };
    files.set(`${map.path}${JSON_SUFFIX}`, `${JSON.stringify(stored, null, 2)}\n`);
  }

  for (const folder of emptyLeafFolders(payload)) {
    files.set(`${folder}/${KEEP_FILE}`, "");
  }

  return new Map([...files].sort(([left], [right]) => compareStrings(left, right)));
}

export function decodeMindMapPayload(files: ReadonlyMap<string, string>): MindMapPayload {
  if (!files || typeof files.entries !== "function") {
    throw new TypeError("Mind Map files must be a ReadonlyMap.");
  }
  const folders = new Set<string>();
  const maps: MindMapDocument[] = [];

  for (const [filePath, text] of files) {
    if (typeof filePath !== "string" || typeof text !== "string") {
      throw new TypeError("Mind Map file paths and contents must be strings.");
    }
    validateFilePath(filePath);

    if (filePath.endsWith(`/${KEEP_FILE}`)) {
      if (text !== "") throw new TypeError(`Folder marker must be empty: ${filePath}`);
      const folder = filePath.slice(0, -(`/${KEEP_FILE}`.length));
      addFolderAndParents(folders, folder);
      continue;
    }

    if (!filePath.endsWith(JSON_SUFFIX)) {
      throw new TypeError(`Unsupported managed Mind Map file: ${filePath}`);
    }
    const path = filePath.slice(0, -JSON_SUFFIX.length);
    const parent = parentPath(path);
    if (parent) addFolderAndParents(folders, parent);
    maps.push(parseStoredMap(text, path, filePath));
  }

  return validateMindMapPayload({ folders: [...folders], maps });
}

function parseStoredMap(text: string, path: string, filePath: string): MindMapDocument {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`Mind Map file is not valid JSON: ${filePath}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Mind Map file must contain an object: ${filePath}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "arrows" || keys[1] !== "id" || keys[2] !== "nodes") {
    throw new TypeError(`Mind Map file has unexpected or missing properties: ${filePath}`);
  }
  return {
    id: record.id as string,
    path,
    nodes: record.nodes as MindMapDocument["nodes"],
    arrows: record.arrows as MindMapDocument["arrows"],
  };
}

function emptyLeafFolders(payload: MindMapPayload): readonly string[] {
  return payload.folders.filter((folder) => {
    const hasChildFolder = payload.folders.some((candidate) => parentPath(candidate) === folder);
    const hasDirectMap = payload.maps.some((map) => parentPath(map.path) === folder);
    return !hasChildFolder && !hasDirectMap;
  });
}

function addFolderAndParents(folders: Set<string>, path: string): void {
  let current = path;
  while (current) {
    folders.add(current);
    current = parentPath(current);
  }
}

function validateFilePath(path: string): void {
  if (
    path.length === 0
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\\")
    || path.includes("//")
    || /[\u0000-\u001f\u007f]/.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`Invalid managed Mind Map path: ${path}`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
