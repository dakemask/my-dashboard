export type LibraryItemKind = "folder" | "map";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const JSON_SUFFIX = /\.json$/iu;
const nameCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export function normalizeFolderName(input: string): string {
  const name = normalizeCommonName(input);
  if (JSON_SUFFIX.test(name)) {
    throw new TypeError("文件夹名称不能以 .json 结尾。");
  }
  return name;
}

export function normalizeMapName(input: string): string {
  let name = normalizeCommonName(input);
  while (JSON_SUFFIX.test(name)) {
    name = normalizeCommonName(name.slice(0, -5));
  }
  return name;
}

export function normalizeFolderPath(input: string): string {
  return normalizePath(input, normalizeFolderName);
}

export function normalizeMapPath(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("脑图路径必须是字符串。");
  }
  const rawParts = input.split("/");
  if (rawParts.length === 0) {
    throw new TypeError("脑图路径不能为空。");
  }
  const mapName = rawParts.pop();
  if (mapName === undefined) {
    throw new TypeError("脑图路径不能为空。");
  }
  const folders = rawParts.map(normalizeFolderName);
  return [...folders, normalizeMapName(mapName)].join("/");
}

export function comparableLibraryName(input: string, kind: LibraryItemKind): string {
  const normalized = kind === "folder"
    ? normalizeFolderName(input)
    : normalizeMapName(input);
  return normalized.toLocaleLowerCase("und");
}

export function sameLibraryName(
  left: string,
  right: string,
  kind: LibraryItemKind,
): boolean {
  return comparableLibraryName(left, kind) === comparableLibraryName(right, kind);
}

/** Chinese UI order with a deterministic code-point tie-breaker. */
export function compareDisplayNames(left: string, right: string): number {
  const compared = nameCollator.compare(left, right);
  if (compared !== 0) return compared;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareLogicalPaths(left: string, right: string): number {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const count = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const compared = compareDisplayNames(leftParts[index]!, rightParts[index]!);
    if (compared !== 0) return compared;
  }
  return leftParts.length - rightParts.length;
}

export function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function baseName(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? path : path.slice(separator + 1);
}

export function isSameOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function normalizePath(input: string, normalizePart: (part: string) => string): string {
  if (typeof input !== "string") {
    throw new TypeError("资料库路径必须是字符串。");
  }
  return input.split("/").map(normalizePart).join("/");
}

function normalizeCommonName(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("名称必须是字符串。");
  }
  const name = input.trim().normalize("NFC");
  if (
    name.length === 0
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || CONTROL_CHARACTERS.test(name)
  ) {
    throw new TypeError("名称不能为空，也不能包含斜杠或控制字符。");
  }
  return name;
}
