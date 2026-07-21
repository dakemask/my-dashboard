import type { ModuleRuntime, ModuleRuntimeHooks, ModuleRuntimeSnapshot } from "../../../src/shared";
import { MindMapController } from "../../../src/mind-map/app/controller";
import {
  applyMindMapEvent,
  invertMindMapEvent,
  validateMindMapPayload,
  type MindMapEvent,
  type MindMapPayload,
} from "../../../src/mind-map/domain";

class FixtureRuntime implements ModuleRuntime<MindMapPayload, MindMapEvent> {
  readonly state = "ready" as const;
  readonly #hooks: ModuleRuntimeHooks<MindMapPayload, MindMapEvent>;
  #versions: MindMapPayload[];
  #events: MindMapEvent[] = [];
  #cursor = 0;
  #saved = 0;
  #snapshot: ModuleRuntimeSnapshot = {
    initialized: true,
    sessionDirty: false,
    localChangedSinceSync: false,
    localSavedAt: "2026-07-13T03:20:00.000Z",
    knownRemoteRevision: "fixture-revision",
    knownRemoteUpdatedAt: "2026-07-13T03:18:00.000Z",
    lastSyncedRemoteRevision: "fixture-revision",
    pendingUpload: null,
    conflict: null,
  };

  constructor(payload: MindMapPayload, hooks: ModuleRuntimeHooks<MindMapPayload, MindMapEvent>) {
    this.#versions = [payload];
    this.#hooks = hooks;
  }

  get current(): MindMapPayload { return this.#versions[this.#cursor]!; }
  get canUndo(): boolean { return this.#cursor > 0; }
  get canRedo(): boolean { return this.#cursor < this.#versions.length - 1; }
  get dirty(): boolean { return this.#cursor !== this.#saved; }

  dispatch(event: MindMapEvent): MindMapPayload {
    const next = applyMindMapEvent(this.current, event);
    this.#versions = [...this.#versions.slice(0, this.#cursor + 1), next];
    this.#events = [...this.#events.slice(0, this.#cursor), event];
    this.#cursor += 1;
    this.#updateSnapshot();
    return next;
  }

  async undo(): Promise<MindMapPayload> {
    await this.#settle("undo");
    if (this.#cursor > 0) {
      const event = this.#events[this.#cursor - 1]!;
      const before = this.#versions[this.#cursor - 1]!;
      const after = this.#versions[this.#cursor]!;
      applyMindMapEvent(after, invertMindMapEvent(event, before, after));
      this.#cursor -= 1;
    }
    this.#hooks.project(this.current, "undo");
    this.#updateSnapshot();
    return this.current;
  }

  async redo(): Promise<MindMapPayload> {
    await this.#settle("redo");
    if (this.#cursor < this.#versions.length - 1) this.#cursor += 1;
    this.#hooks.project(this.current, "redo");
    this.#updateSnapshot();
    return this.current;
  }

  async save(): Promise<"saved" | "unchanged"> {
    await this.#settle("local-save");
    if (!this.dirty) return "unchanged";
    this.#saved = this.#cursor;
    this.#snapshot = { ...this.#snapshot, localSavedAt: new Date().toISOString() };
    this.#updateSnapshot();
    return "saved";
  }

  async upload(): Promise<"uploaded"> {
    await this.save();
    const now = new Date().toISOString();
    this.#snapshot = {
      ...this.#snapshot,
      localChangedSinceSync: false,
      knownRemoteUpdatedAt: now,
    };
    this.#notify();
    return "uploaded";
  }

  async pull(): Promise<"unchanged"> { return "unchanged"; }
  async resolveConflict(): Promise<"unchanged"> { return "unchanged"; }
  async pollNow(): Promise<void> {}
  getSnapshot(): ModuleRuntimeSnapshot { return structuredClone(this.#snapshot); }
  async dispose(): Promise<void> {}

  async #settle(reason: "local-save" | "upload" | "pull" | "remote-change" | "undo" | "redo"): Promise<void> {
    const event = await this.#hooks.settle(reason);
    if (event) this.dispatch(event);
  }

  #updateSnapshot(): void {
    this.#snapshot = {
      ...this.#snapshot,
      sessionDirty: this.dirty,
      localChangedSinceSync: this.#snapshot.localChangedSinceSync || this.dirty,
    };
    this.#notify();
  }

  #notify(): void {
    this.#hooks.onSnapshotChange?.(this.getSnapshot());
  }
}

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Fixture app root is missing.");

sessionStorage.setItem("my-dashboard.mind-maps.last-map-id", "map-product");
sessionStorage.setItem(
  "my-dashboard.mind-maps.expanded-folders",
  JSON.stringify(["工作", "工作/项目", "生活"]),
);
const controller = new MindMapController(root, {
  storage: sessionStorage,
  navigateHome: () => undefined,
});
const runtime = new FixtureRuntime(samplePayload(), controller.hooks);
controller.hooks.project(runtime.current, "initialize");
controller.attachRuntime(runtime, runtime.current);

function samplePayload(): MindMapPayload {
  return validateMindMapPayload({
    folders: ["工作", "工作/项目", "生活"],
    maps: [
      {
        id: "map-product",
        path: "工作/项目/产品规划",
        nodes: [
          { id: "node-a", text: "新版个人仪表盘", x: 80, y: 90, width: 210, height: 58, autoWidth: true },
          { id: "node-b", text: "思维导图\n自由画布", x: 390, y: 28, width: 180, height: 72, autoWidth: false },
          { id: "node-c", text: "碎片想法\n稍后开发", x: 390, y: 190, width: 180, height: 72, autoWidth: false },
        ],
        arrows: [
          { id: "arrow-a", from: { nodeId: "node-a", side: "right" }, to: { nodeId: "node-b", side: "left" } },
          { id: "arrow-b", from: { nodeId: "node-a", side: "right" }, to: { nodeId: "node-c", side: "left" } },
        ],
      },
      { id: "map-life", path: "生活/旅行清单", nodes: [], arrows: [] },
    ],
  });
}
