import { describe, expect, it } from "vitest";
import { MindMapPreferences } from "../../src/mind-maps/app/preferences";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();
  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

describe("MindMapPreferences", () => {
  it("defaults the sidebar to open and persists local-only preferences", () => {
    const storage = new MemoryStorage();
    const first = new MindMapPreferences(storage);
    expect(first.snapshot.sidebarOpen).toBe(true);

    first.setSidebarOpen(false);
    first.setLastMapId("map-1");
    first.setFolderExpanded("工作/计划", true);

    const restored = new MindMapPreferences(storage).snapshot;
    expect(restored.sidebarOpen).toBe(false);
    expect(restored.lastMapId).toBe("map-1");
    expect([...restored.expandedFolders]).toEqual(["工作/计划"]);
  });

  it("remaps and prunes expanded folder paths", () => {
    const preferences = new MindMapPreferences(new MemoryStorage());
    preferences.setFolderExpanded("旧目录", true);
    preferences.setFolderExpanded("旧目录/子目录", true);
    preferences.setFolderExpanded("保留", true);

    preferences.remapFolderPrefix("旧目录", "新目录");
    expect([...preferences.snapshot.expandedFolders].sort()).toEqual([
      "保留",
      "新目录",
      "新目录/子目录",
    ]);

    preferences.retainFolders(["新目录", "保留"]);
    expect([...preferences.snapshot.expandedFolders].sort()).toEqual(["保留", "新目录"]);
  });

  it("ignores corrupt stored values", () => {
    const storage = new MemoryStorage();
    storage.setItem("my-dashboard.mind-maps.expanded-folders", "not-json");
    storage.setItem("my-dashboard.mind-maps.sidebar-open", "invalid");
    const snapshot = new MindMapPreferences(storage).snapshot;
    expect(snapshot.sidebarOpen).toBe(true);
    expect(snapshot.expandedFolders.size).toBe(0);
  });
});
