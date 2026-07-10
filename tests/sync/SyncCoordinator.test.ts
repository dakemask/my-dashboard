import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperationGate } from "../../src/shared/concurrency";
import {
  RemoteModuleConflictError,
  type RemoteModuleOverwriteOptions,
  type RemoteModulePushOptions,
  type RemoteModulePushResult,
  type RemoteModuleSnapshot,
  type RemoteRevisionSnapshot,
} from "../../src/shared/github";
import { ModuleLocalStore } from "../../src/shared/persistence";
import {
  SyncConflictPendingError,
  SyncCoordinator,
  type ModuleDefinition,
  type RemoteModulePort,
} from "../../src/shared/sync";

interface TestData {
  value: string;
}

class FakeRemote implements RemoteModulePort<TestData> {
  readonly moduleId: string;
  revision: string | null = null;
  data: TestData | null = null;
  loseNextPushResponse = false;

  constructor(moduleId: string) {
    this.moduleId = moduleId;
  }

  async readRevision(): Promise<RemoteRevisionSnapshot | null> {
    return this.revision ? this.revisionSnapshot(this.revision) : null;
  }

  async pull(): Promise<RemoteModuleSnapshot<TestData> | null> {
    if (!this.revision || !this.data) {
      return null;
    }
    return { ...this.revisionSnapshot(this.revision), data: structuredClone(this.data), files: new Map() };
  }

  async push(data: TestData, options: RemoteModulePushOptions): Promise<RemoteModulePushResult> {
    if (this.revision === options.nextRevision) {
      return { ...this.revisionSnapshot(this.revision), status: "already-committed" };
    }
    if (this.revision !== options.expectedRevision) {
      throw new RemoteModuleConflictError(options.expectedRevision, this.revision);
    }
    this.revision = options.nextRevision;
    this.data = structuredClone(data);
    if (this.loseNextPushResponse) {
      this.loseNextPushResponse = false;
      throw new Error("response lost");
    }
    return { ...this.revisionSnapshot(this.revision), status: "committed" };
  }

  async overwrite(data: TestData, options: RemoteModuleOverwriteOptions): Promise<RemoteModulePushResult> {
    this.revision = options.nextRevision;
    this.data = structuredClone(data);
    return { ...this.revisionSnapshot(this.revision), status: "committed" };
  }

  private revisionSnapshot(revision: string): RemoteRevisionSnapshot {
    return { revision, updatedAt: "2026-07-10T00:00:00.000Z", managedFiles: ["data.json"], commitSha: revision };
  }
}

function definition(moduleId: string): ModuleDefinition<TestData> {
  return {
    moduleId,
    createEmpty: () => ({ value: "empty" }),
    validate(value: unknown): TestData {
      if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") {
        throw new TypeError("invalid test data");
      }
      return { value: (value as TestData).value };
    },
    encode: (data) => new Map([["data.json", JSON.stringify(data)]]),
    decode: (files) => JSON.parse(files.get("data.json") ?? "null") as TestData,
  };
}

function createHarness(moduleId: string, remote = new FakeRemote(moduleId)) {
  const localStore = new ModuleLocalStore<TestData>(moduleId, { indexedDB: new IDBFactory() });
  const project = vi.fn();
  const reload = vi.fn();
  const conflict = vi.fn();
  const coordinator = new SyncCoordinator({
    definition: definition(moduleId),
    localStore,
    remoteRepository: remote,
    operationGate: new OperationGate(),
    hooks: { settle: () => null, project, reload, onConflict: conflict },
    now: () => new Date("2026-07-10T00:00:00.000Z"),
    createUuid: (() => {
      let id = 0;
      return () => `remote-${++id}`;
    })(),
  });
  return { coordinator, localStore, remote, project, reload, conflict };
}

beforeEach(() => vi.restoreAllMocks());

describe("SyncCoordinator", () => {
  it("checks the cloud before creating an empty first-device database", async () => {
    const harness = createHarness("module-init");
    harness.remote.revision = "cloud-1";
    harness.remote.data = { value: "from cloud" };

    await expect(harness.coordinator.initialize()).resolves.toEqual({ value: "from cloud" });
    expect(harness.project).toHaveBeenCalledWith({ value: "from cloud" }, "initialize");
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      sessionDirty: false,
      localChangedSinceSync: false,
      lastSyncedRemoteRevision: "cloud-1",
    });
  });

  it("automatically saves a dirty staging payload before upload", async () => {
    const harness = createHarness("module-upload");
    await harness.coordinator.initialize();
    harness.coordinator.commit({ value: "local change" });

    await expect(harness.coordinator.upload()).resolves.toBe("uploaded");
    expect(harness.remote.data).toEqual({ value: "local change" });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      sessionDirty: false,
      localChangedSinceSync: false,
      pendingUpload: null,
    });
  });

  it("persists a conflict when both local and remote changed", async () => {
    const harness = createHarness("module-conflict");
    await harness.coordinator.initialize();
    harness.coordinator.commit({ value: "unsaved local" });
    harness.remote.revision = "cloud-new";
    harness.remote.data = { value: "remote" };

    await expect(harness.coordinator.upload()).rejects.toBeInstanceOf(SyncConflictPendingError);
    expect(harness.coordinator.getSnapshot().conflict?.observedRemoteRevision).toBe("cloud-new");
    expect((await harness.localStore.load())?.conflict?.observedRemoteRevision).toBe("cloud-new");
    expect(harness.conflict).toHaveBeenCalled();
  });

  it("does not create a conflict when pull sees an unchanged cloud and local edits", async () => {
    const harness = createHarness("module-local-only");
    await harness.coordinator.initialize();
    harness.coordinator.commit({ value: "local edit" });

    await expect(harness.coordinator.pull()).resolves.toBe("unchanged");
    expect(harness.coordinator.getSnapshot().conflict).toBeNull();
    expect(harness.coordinator.getSnapshot().sessionDirty).toBe(true);
  });

  it("automatically pulls and reloads when only the cloud changed", async () => {
    const harness = createHarness("module-pull");
    await harness.coordinator.initialize();
    harness.remote.revision = "cloud-new";
    harness.remote.data = { value: "remote" };

    await expect(harness.coordinator.handleObservedRemoteRevision("cloud-new")).resolves.toBe("reloaded");
    expect((await harness.localStore.load())?.payload).toEqual({ value: "remote" });
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("uses the persisted next revision to confirm a lost upload response", async () => {
    const harness = createHarness("module-idempotent");
    await harness.coordinator.initialize();
    harness.coordinator.commit({ value: "important" });
    harness.remote.loseNextPushResponse = true;

    await expect(harness.coordinator.upload()).rejects.toThrow("response lost");
    expect(harness.coordinator.getSnapshot().pendingUpload?.nextRemoteRevision).toBe("remote-1");

    await expect(harness.coordinator.upload()).resolves.toBe("unchanged");
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      pendingUpload: null,
      localChangedSinceSync: false,
      lastSyncedRemoteRevision: "remote-1",
    });
  });

  it("supports explicit cloud-wins conflict resolution", async () => {
    const harness = createHarness("module-cloud-wins");
    await harness.coordinator.initialize();
    harness.coordinator.commit({ value: "local" });
    harness.remote.revision = "cloud-2";
    harness.remote.data = { value: "remote wins" };
    await harness.coordinator.handleObservedRemoteRevision("cloud-2");

    await expect(harness.coordinator.resolveConflict("cloud-wins")).resolves.toBe("reloaded");
    expect((await harness.localStore.load())?.payload).toEqual({ value: "remote wins" });
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("supports explicit local-wins conflict resolution", async () => {
    const harness = createHarness("module-local-wins");
    await harness.coordinator.initialize();
    harness.coordinator.commit({ value: "local wins" });
    harness.remote.revision = "cloud-2";
    harness.remote.data = { value: "remote loses" };
    await harness.coordinator.handleObservedRemoteRevision("cloud-2");

    await expect(harness.coordinator.resolveConflict("local-wins")).resolves.toBe("uploaded");
    expect(harness.remote.data).toEqual({ value: "local wins" });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      sessionDirty: false,
      localChangedSinceSync: false,
      conflict: null,
      pendingUpload: null,
    });
  });

  it("does not auto-pull a persisted conflict after current content returns to the baseline", async () => {
    const harness = createHarness("module-conflict-stays");
    await harness.coordinator.initialize();
    harness.coordinator.commit({ value: "temporary" });
    harness.remote.revision = "cloud-3";
    harness.remote.data = { value: "remote" };
    await harness.coordinator.handleObservedRemoteRevision("cloud-3");

    await harness.coordinator.undo();
    expect(harness.coordinator.getSnapshot().sessionDirty).toBe(false);

    await expect(harness.coordinator.pull()).resolves.toBe("conflict");
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot().conflict?.observedRemoteRevision).toBe("cloud-3");
  });
});
