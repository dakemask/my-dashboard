const PREFIX = "my-dashboard.mind-maps.";
const SIDEBAR_KEY = `${PREFIX}sidebar-open`;
const LAST_MAP_KEY = `${PREFIX}last-map-id`;
const EXPANDED_KEY = `${PREFIX}expanded-folders`;

export interface MindMapPreferenceSnapshot {
  readonly sidebarOpen: boolean;
  readonly lastMapId: string | null;
  readonly expandedFolders: ReadonlySet<string>;
}

export class MindMapPreferences {
  readonly #storage: Storage | null;
  #sidebarOpen: boolean;
  #lastMapId: string | null;
  #expandedFolders: Set<string>;

  constructor(storage: Storage | null = safeLocalStorage()) {
    this.#storage = storage;
    this.#sidebarOpen = readBoolean(storage, SIDEBAR_KEY, true);
    this.#lastMapId = readString(storage, LAST_MAP_KEY);
    this.#expandedFolders = readStringSet(storage, EXPANDED_KEY);
  }

  get snapshot(): MindMapPreferenceSnapshot {
    return {
      sidebarOpen: this.#sidebarOpen,
      lastMapId: this.#lastMapId,
      expandedFolders: new Set(this.#expandedFolders),
    };
  }

  setSidebarOpen(open: boolean): void {
    this.#sidebarOpen = open;
    write(this.#storage, SIDEBAR_KEY, String(open));
  }

  setLastMapId(mapId: string | null): void {
    this.#lastMapId = mapId;
    if (mapId === null) {
      remove(this.#storage, LAST_MAP_KEY);
      return;
    }
    write(this.#storage, LAST_MAP_KEY, mapId);
  }

  setFolderExpanded(path: string, expanded: boolean): void {
    if (expanded) {
      this.#expandedFolders.add(path);
    } else {
      this.#expandedFolders.delete(path);
    }
    this.#persistExpanded();
  }

  expandAncestors(path: string): void {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      this.#expandedFolders.add(current);
    }
    this.#persistExpanded();
  }

  remapFolderPrefix(from: string, to: string): void {
    const next = new Set<string>();
    for (const path of this.#expandedFolders) {
      if (path === from || path.startsWith(`${from}/`)) {
        next.add(`${to}${path.slice(from.length)}`);
      } else {
        next.add(path);
      }
    }
    this.#expandedFolders = next;
    this.#persistExpanded();
  }

  retainFolders(paths: readonly string[]): void {
    const available = new Set(paths);
    const next = new Set([...this.#expandedFolders].filter((path) => available.has(path)));
    if (setsEqual(next, this.#expandedFolders)) return;
    this.#expandedFolders = next;
    this.#persistExpanded();
  }

  #persistExpanded(): void {
    write(this.#storage, EXPANDED_KEY, JSON.stringify([...this.#expandedFolders].sort()));
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readBoolean(storage: Storage | null, key: string, fallback: boolean): boolean {
  const value = read(storage, key);
  return value === "true" ? true : value === "false" ? false : fallback;
}

function readString(storage: Storage | null, key: string): string | null {
  const value = read(storage, key);
  return value && value.length > 0 ? value : null;
}

function readStringSet(storage: Storage | null, key: string): Set<string> {
  const value = read(storage, key);
  if (!value) return new Set();
  try {
    const parsed = JSON.parse(value) as unknown;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [],
    );
  } catch {
    return new Set();
  }
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // UI preferences are best effort and never block business actions.
  }
}

function remove(storage: Storage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // UI preferences are best effort and never block business actions.
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}
