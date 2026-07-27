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
import { jsonContentKey } from "../../src/shared/history";
import {
  ModuleLocalStore,
  createModuleLocalEnvelope,
} from "../../src/shared/persistence";
import {
  MissingModuleSchemaVersionError,
  SyncConflictPendingError,
  SyncCoordinator,
  hashContentKey,
  type ModuleDefinition,
  type RemoteModulePort,
} from "../../src/shared/sync";

interface TestData {
  value: string;
}

interface TestEvent {
  readonly type: "set-value";
  readonly value: string;
}

const setValue = (value: string): TestEvent => ({ type: "set-value", value });

class FakeRemote implements RemoteModulePort<TestData> {
  readonly moduleId: string;
  revision: string | null = null;
  updatedAt = "2026-07-10T00:00:00.000Z";
  data: TestData | null = null;
  loseNextPushResponse = false;
  raceOnNextPush: RemoteModuleSnapshot<TestData> | null = null;

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
    if (this.raceOnNextPush) {
      this.revision = this.raceOnNextPush.revision;
      this.updatedAt = this.raceOnNextPush.updatedAt;
      this.data = structuredClone(this.raceOnNextPush.data);
      this.raceOnNextPush = null;
    }
    if (this.revision === options.nextRevision) {
      return { ...this.revisionSnapshot(this.revision), status: "already-committed" };
    }
    if (this.revision !== options.expectedRevision) {
      throw new RemoteModuleConflictError(options.expectedRevision, this.revision, this.updatedAt);
    }
    this.revision = options.nextRevision;
    this.updatedAt = options.updatedAt ?? this.updatedAt;
    this.data = structuredClone(data);
    if (this.loseNextPushResponse) {
      this.loseNextPushResponse = false;
      throw new Error("response lost");
    }
    return { ...this.revisionSnapshot(this.revision), status: "committed" };
  }

  async overwrite(data: TestData, options: RemoteModuleOverwriteOptions): Promise<RemoteModulePushResult> {
    this.revision = options.nextRevision;
    this.updatedAt = options.updatedAt ?? this.updatedAt;
    this.data = structuredClone(data);
    return { ...this.revisionSnapshot(this.revision), status: "committed" };
  }

  private revisionSnapshot(revision: string): RemoteRevisionSnapshot {
    return {
      revision,
      updatedAt: this.updatedAt,
      managedFiles: ["data.json"],
      commitSha: revision,
    };
  }
}

function definition(moduleId: string): ModuleDefinition<TestData, TestEvent> {
  return {
    moduleId,
    createEmpty: () => ({ value: "empty" }),
    validate(value: unknown): TestData {
      if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") {
        throw new TypeError("invalid test data");
      }
      return { value: (value as TestData).value };
    },
    contentKey: jsonContentKey,
    history: {
      capacity: 100,
      apply: (_payload, event) => ({ value: event.value }),
      invert: (_event, before) => setValue(before.value),
    },
    encode: (data) => new Map([["data.json", JSON.stringify(data)]]),
    decode: (files) => JSON.parse(files.get("data.json") ?? "null") as TestData,
  };
}

function createHarness(
  moduleId: string,
  remote = new FakeRemote(moduleId),
  settle: () => TestEvent | null = () => null,
  now: () => Date = () => new Date("2026-07-10T00:00:00.000Z"),
) {
  const indexedDB = new IDBFactory();
  const localStore = new ModuleLocalStore<TestData>(moduleId, { indexedDB });
  const project = vi.fn();
  const reload = vi.fn();
  const conflict = vi.fn();
  const coordinator = new SyncCoordinator({
    definition: definition(moduleId),
    localStore,
    remoteRepository: remote,
    operationGate: new OperationGate(),
    hooks: { settle, project, reload, onConflict: conflict },
    now,
    createUuid: (() => {
      let id = 0;
      return () => `remote-${++id}`;
    })(),
  });
  return {
    coordinator,
    localStore,
    indexedDB,
    remote,
    project,
    reload,
    conflict,
    settle,
  };
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
      localSavedAt: "2026-07-10T00:00:00.000Z",
      knownRemoteRevision: "cloud-1",
      knownRemoteUpdatedAt: "2026-07-10T00:00:00.000Z",
      lastSyncedRemoteRevision: "cloud-1",
    });
    await expect(harness.localStore.load()).resolves.toMatchObject({
      localSavedAt: "2026-07-10T00:00:00.000Z",
      lastSyncedRemoteUpdatedAt: "2026-07-10T00:00:00.000Z",
    });
  });

  it("automatically saves a dirty staging payload before upload", async () => {
    let now = "2026-07-10T00:00:00.000Z";
    const harness = createHarness(
      "module-upload",
      undefined,
      undefined,
      () => new Date(now),
    );
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("local change"));
    now = "2026-07-10T01:00:00.000Z";

    await expect(harness.coordinator.upload()).resolves.toBe("uploaded");
    expect(harness.remote.data).toEqual({ value: "local change" });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      sessionDirty: false,
      localChangedSinceSync: false,
      localSavedAt: "2026-07-10T01:00:00.000Z",
      knownRemoteRevision: "remote-1",
      knownRemoteUpdatedAt: "2026-07-10T01:00:00.000Z",
      pendingUpload: null,
    });
  });

  it("dispatches a settled event before upload and uploads its resulting payload", async () => {
    const settle = vi.fn(() => setValue("settled for upload"));
    const harness = createHarness(
      "module-upload-settle",
      new FakeRemote("module-upload-settle"),
      settle,
    );
    await harness.coordinator.initialize();

    await expect(harness.coordinator.upload()).resolves.toBe("uploaded");
    expect(settle).toHaveBeenCalledWith("upload");
    expect(harness.remote.data).toEqual({ value: "settled for upload" });
    expect(harness.coordinator.history.dirty).toBe(false);
  });

  it("dispatches a redo settlement event before deciding the old redo branch", async () => {
    let pending: TestEvent | null = null;
    const settle = vi.fn(() => {
      const event = pending;
      pending = null;
      return event;
    });
    const harness = createHarness(
      "module-redo-settle",
      new FakeRemote("module-redo-settle"),
      settle,
    );
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("B"));
    await harness.coordinator.undo();
    pending = setValue("C");

    await expect(harness.coordinator.redo()).resolves.toEqual({ value: "C" });
    expect(settle).toHaveBeenCalledWith("redo");
    expect(harness.coordinator.history.canRedo).toBe(false);
  });

  it("persists a conflict when both local and remote changed", async () => {
    let now = "2026-07-10T00:00:00.000Z";
    const harness = createHarness(
      "module-conflict",
      undefined,
      undefined,
      () => new Date(now),
    );
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("unsaved local"));
    harness.remote.revision = "cloud-new";
    harness.remote.updatedAt = "2026-07-10T00:30:00.000Z";
    harness.remote.data = { value: "remote" };
    now = "2026-07-10T01:00:00.000Z";

    await expect(harness.coordinator.upload()).rejects.toBeInstanceOf(SyncConflictPendingError);
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      localSavedAt: "2026-07-10T01:00:00.000Z",
      knownRemoteRevision: "cloud-new",
      knownRemoteUpdatedAt: "2026-07-10T00:30:00.000Z",
      conflict: {
        observedRemoteRevision: "cloud-new",
        observedRemoteUpdatedAt: "2026-07-10T00:30:00.000Z",
      },
    });
    expect((await harness.localStore.load())?.conflict?.observedRemoteRevision).toBe("cloud-new");
    expect(harness.conflict).toHaveBeenCalled();

    const exposed = harness.coordinator.getSnapshot().conflict as {
      observedRemoteRevision: string | null;
    };
    exposed.observedRemoteRevision = "tampered";
    expect(harness.coordinator.getSnapshot().conflict?.observedRemoteRevision).toBe("cloud-new");
  });

  it("preserves the remote timestamp when a ref race creates an upload conflict", async () => {
    const harness = createHarness("module-ref-race-time");
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("local"));
    harness.remote.raceOnNextPush = {
      revision: "cloud-raced",
      updatedAt: "2026-07-10T03:04:05.000Z",
      managedFiles: ["data.json"],
      commitSha: "cloud-raced",
      data: { value: "remote" },
      files: new Map(),
    };

    await expect(harness.coordinator.upload()).rejects.toBeInstanceOf(SyncConflictPendingError);
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      knownRemoteRevision: "cloud-raced",
      knownRemoteUpdatedAt: "2026-07-10T03:04:05.000Z",
      conflict: {
        observedRemoteRevision: "cloud-raced",
        observedRemoteUpdatedAt: "2026-07-10T03:04:05.000Z",
      },
    });
  });

  it("does not create a conflict when pull sees an unchanged cloud and local edits", async () => {
    const harness = createHarness("module-local-only");
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("local edit"));

    await expect(harness.coordinator.pull()).resolves.toBe("unchanged");
    expect(harness.coordinator.getSnapshot().conflict).toBeNull();
    expect(harness.coordinator.getSnapshot().sessionDirty).toBe(true);
  });

  it("automatically pulls and reloads when only the cloud changed", async () => {
    let now = "2026-07-10T00:00:00.000Z";
    const harness = createHarness(
      "module-pull",
      undefined,
      undefined,
      () => new Date(now),
    );
    await harness.coordinator.initialize();
    harness.remote.revision = "cloud-new";
    harness.remote.updatedAt = "2026-07-10T00:30:00.000Z";
    harness.remote.data = { value: "remote" };
    now = "2026-07-10T01:00:00.000Z";

    await expect(
      harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision()),
    ).resolves.toBe("reloaded");
    await expect(harness.localStore.load()).resolves.toMatchObject({
      payload: { value: "remote" },
      localSavedAt: "2026-07-10T01:00:00.000Z",
      lastSyncedRemoteRevision: "cloud-new",
      lastSyncedRemoteUpdatedAt: "2026-07-10T00:30:00.000Z",
    });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      knownRemoteRevision: "cloud-new",
      knownRemoteUpdatedAt: "2026-07-10T00:30:00.000Z",
    });
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("settles a live event before a polled cloud change can be treated as clean", async () => {
    const settle = vi.fn(() => setValue("live edit"));
    const harness = createHarness(
      "module-poll-settle",
      new FakeRemote("module-poll-settle"),
      settle,
    );
    await harness.coordinator.initialize();
    harness.remote.revision = "cloud-new";
    harness.remote.data = { value: "remote" };

    await expect(
      harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision()),
    ).resolves.toBe("conflict");
    expect(settle).toHaveBeenCalledWith("remote-change");
    expect(harness.coordinator.history.current).toEqual({ value: "live edit" });
    expect(harness.reload).not.toHaveBeenCalled();
    const refreshedStore = new ModuleLocalStore<TestData>("module-poll-settle", {
      indexedDB: harness.indexedDB,
    });
    await expect(refreshedStore.load()).resolves.toMatchObject({
      payload: { value: "live edit" },
      conflict: { observedRemoteRevision: "cloud-new" },
    });
    refreshedStore.close();
  });

  it("settles a live event when an existing conflict advances to another revision", async () => {
    let pending: TestEvent | null = null;
    const settle = vi.fn(() => pending);
    const harness = createHarness(
      "module-conflict-advances",
      new FakeRemote("module-conflict-advances"),
      settle,
    );
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("local"));
    harness.remote.revision = "cloud-r1";
    harness.remote.data = { value: "remote one" };
    await harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision());

    settle.mockClear();
    pending = setValue("live during conflict");
    harness.remote.revision = "cloud-r2";
    harness.remote.updatedAt = "2026-07-10T05:00:00.000Z";
    harness.remote.data = { value: "remote two" };

    await expect(
      harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision()),
    ).resolves.toBe("conflict");
    expect(settle).toHaveBeenCalledWith("remote-change");
    expect(harness.coordinator.history.current).toEqual({ value: "live during conflict" });
    await expect(harness.localStore.load()).resolves.toMatchObject({
      payload: { value: "live during conflict" },
      conflict: {
        observedRemoteRevision: "cloud-r2",
        observedRemoteUpdatedAt: "2026-07-10T05:00:00.000Z",
      },
    });
  });

  it("settles a live event before an explicit pull compares local state", async () => {
    const settle = vi.fn(() => setValue("live edit"));
    const harness = createHarness(
      "module-pull-settle",
      new FakeRemote("module-pull-settle"),
      settle,
    );
    await harness.coordinator.initialize();
    harness.remote.revision = "cloud-new";
    harness.remote.data = { value: "remote" };

    await expect(harness.coordinator.pull()).resolves.toBe("conflict");
    expect(settle).toHaveBeenCalledWith("pull");
    expect(harness.coordinator.history.current).toEqual({ value: "live edit" });
    expect(harness.reload).not.toHaveBeenCalled();
    const refreshedStore = new ModuleLocalStore<TestData>("module-pull-settle", {
      indexedDB: harness.indexedDB,
    });
    await expect(refreshedStore.load()).resolves.toMatchObject({
      payload: { value: "live edit" },
      conflict: { observedRemoteRevision: "cloud-new" },
    });
    refreshedStore.close();
  });

  it("uses the persisted next revision to confirm a lost upload response", async () => {
    const harness = createHarness("module-idempotent");
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("important"));
    harness.remote.loseNextPushResponse = true;

    await expect(harness.coordinator.upload()).rejects.toThrow("response lost");
    expect(harness.coordinator.getSnapshot().pendingUpload?.nextRemoteRevision).toBe("remote-1");

    await expect(harness.coordinator.upload()).resolves.toBe("unchanged");
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      pendingUpload: null,
      localChangedSinceSync: false,
      knownRemoteRevision: "remote-1",
      knownRemoteUpdatedAt: "2026-07-10T00:00:00.000Z",
      lastSyncedRemoteRevision: "remote-1",
    });
  });

  it("backfills a remote timestamp when a legacy baseline has the same revision", async () => {
    const harness = createHarness("module-time-backfill");
    const payload = { value: "empty" };
    const contentHash = await hashContentKey(jsonContentKey(payload));
    await harness.localStore.initialize({
      ...createModuleLocalEnvelope(
        payload,
        contentHash,
        "00000000-0000-4000-8000-000000000030",
      ),
      lastSyncedContentHash: contentHash,
      lastSyncedRemoteRevision: "cloud-legacy",
    });
    harness.remote.revision = "cloud-legacy";
    harness.remote.updatedAt = "2026-07-09T12:00:00.000Z";
    harness.remote.data = payload;

    await harness.coordinator.initialize();
    expect(harness.coordinator.getSnapshot().knownRemoteUpdatedAt).toBeNull();
    await expect(
      harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision()),
    ).resolves.toBe("unchanged");

    expect(harness.coordinator.getSnapshot()).toMatchObject({
      localSavedAt: null,
      knownRemoteRevision: "cloud-legacy",
      knownRemoteUpdatedAt: "2026-07-09T12:00:00.000Z",
    });
    await expect(harness.localStore.load()).resolves.toMatchObject({
      localSavedAt: null,
      lastSyncedRemoteUpdatedAt: "2026-07-09T12:00:00.000Z",
    });
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("backfills a remote timestamp for a persisted conflict without resaving payload data", async () => {
    const harness = createHarness("module-conflict-time-backfill");
    const payload = { value: "empty" };
    const contentHash = await hashContentKey(jsonContentKey(payload));
    await harness.localStore.initialize({
      ...createModuleLocalEnvelope(
        payload,
        contentHash,
        "00000000-0000-4000-8000-000000000031",
      ),
      lastSyncedContentHash: contentHash,
      lastSyncedRemoteRevision: "cloud-base",
      conflict: {
        observedRemoteRevision: "cloud-conflict",
        observedRemoteUpdatedAt: null,
        detectedAt: "2026-07-09T10:00:00.000Z",
      },
    });
    harness.remote.revision = "cloud-conflict";
    harness.remote.updatedAt = "2026-07-09T12:00:00.000Z";
    harness.remote.data = { value: "remote" };

    await harness.coordinator.initialize();
    await expect(
      harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision()),
    ).resolves.toBe("conflict");

    expect(harness.coordinator.getSnapshot()).toMatchObject({
      localSavedAt: null,
      knownRemoteRevision: "cloud-conflict",
      knownRemoteUpdatedAt: "2026-07-09T12:00:00.000Z",
      conflict: {
        observedRemoteUpdatedAt: "2026-07-09T12:00:00.000Z",
        detectedAt: "2026-07-09T10:00:00.000Z",
      },
    });
    expect(harness.conflict).toHaveBeenCalledTimes(2);
  });

  it("supports explicit cloud-wins conflict resolution", async () => {
    const harness = createHarness("module-cloud-wins");
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("local"));
    harness.remote.revision = "cloud-2";
    harness.remote.data = { value: "remote wins" };
    await harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision());

    await expect(harness.coordinator.resolveConflict("cloud-wins")).resolves.toBe("reloaded");
    expect((await harness.localStore.load())?.payload).toEqual({ value: "remote wins" });
    expect(harness.coordinator.history.current).toEqual({ value: "remote wins" });
    expect(harness.coordinator.history.canUndo).toBe(false);
    expect(harness.coordinator.history.dirty).toBe(false);
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("supports explicit local-wins conflict resolution", async () => {
    const settle = vi.fn(() => null);
    const harness = createHarness(
      "module-local-wins",
      new FakeRemote("module-local-wins"),
      settle,
    );
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("local wins"));
    harness.remote.revision = "cloud-2";
    harness.remote.data = { value: "remote loses" };
    await harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision());

    await expect(harness.coordinator.resolveConflict("local-wins")).resolves.toBe("uploaded");
    expect(settle).toHaveBeenLastCalledWith("upload");
    expect(harness.remote.data).toEqual({ value: "local wins" });
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      sessionDirty: false,
      localChangedSinceSync: false,
      conflict: null,
      pendingUpload: null,
    });
  });

  it("does not auto-pull after the conflict snapshot becomes the saved baseline", async () => {
    const harness = createHarness("module-conflict-stays");
    await harness.coordinator.initialize();
    harness.coordinator.dispatch(setValue("temporary"));
    harness.remote.revision = "cloud-3";
    harness.remote.data = { value: "remote" };
    await harness.coordinator.handleObservedRemoteRevision(await harness.remote.readRevision());

    expect(harness.coordinator.getSnapshot().sessionDirty).toBe(false);

    await expect(harness.coordinator.pull()).resolves.toBe("conflict");
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot().conflict?.observedRemoteRevision).toBe("cloud-3");
  });

  it("saves a non-JSON payload using the module's content key", async () => {
    interface RichPayload {
      readonly updatedAt: Date;
      readonly counters: Map<string, number>;
    }
    interface RichEvent {
      readonly type: "replace";
      readonly payload: RichPayload;
    }

    const moduleId = "module-rich-payload";
    const richDefinition: ModuleDefinition<RichPayload, RichEvent> = {
      moduleId,
      createEmpty: () => ({ updatedAt: new Date(0), counters: new Map() }),
      validate(value: unknown): RichPayload {
        const candidate = value as Partial<RichPayload>;
        if (!(candidate?.updatedAt instanceof Date) || !(candidate.counters instanceof Map)) {
          throw new TypeError("invalid rich payload");
        }
        return candidate as RichPayload;
      },
      contentKey: (payload) => {
        const counters = [...payload.counters]
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([name, count]) => `${name}:${count}`)
          .join("|");
        return `${payload.updatedAt.toISOString()}|${counters}`;
      },
      history: {
        capacity: "unlimited",
        apply: (_payload, event) => event.payload,
        invert: (_event, before) => ({ type: "replace", payload: before }),
      },
      encode: (payload) => new Map([["data.txt", JSON.stringify({
        updatedAt: payload.updatedAt.toISOString(),
        counters: [...payload.counters].sort(
          ([left], [right]) => left < right ? -1 : left > right ? 1 : 0,
        ),
      })]]),
      decode: (files) => {
        const decoded = JSON.parse(files.get("data.txt") ?? "null") as {
          updatedAt: string;
          counters: Array<[string, number]>;
        };
        return {
          updatedAt: new Date(decoded.updatedAt),
          counters: new Map(decoded.counters),
        };
      },
    };
    const remoteRepository: RemoteModulePort<RichPayload> = {
      moduleId,
      readRevision: async () => null,
      pull: async () => null,
      push: async () => Promise.reject(new Error("not used")),
      overwrite: async () => Promise.reject(new Error("not used")),
    };
    const localStore = new ModuleLocalStore<RichPayload>(moduleId, { indexedDB: new IDBFactory() });
    const coordinator = new SyncCoordinator({
      definition: richDefinition,
      localStore,
      remoteRepository,
      operationGate: new OperationGate(),
      hooks: { settle: () => null, project: () => undefined, reload: () => undefined },
    });
    await coordinator.initialize();

    coordinator.dispatch({
      type: "replace",
      payload: {
        updatedAt: new Date("2026-07-11T01:02:03.000Z"),
        counters: new Map([["ideas", 2]]),
      },
    });
    await expect(coordinator.saveLocal()).resolves.toBe("saved");

    const stored = await localStore.load();
    expect(stored?.payload.updatedAt).toBeInstanceOf(Date);
    expect(stored?.payload.counters).toEqual(new Map([["ideas", 2]]));
    expect(coordinator.getSnapshot()).toMatchObject({
      sessionDirty: false,
      localChangedSinceSync: true,
    });
  });
});

interface VersionOneData {
  readonly value: string;
}

interface VersionTwoData {
  readonly value: string;
  readonly normalized: string;
}

class VersionedRemote implements RemoteModulePort<VersionTwoData> {
  readonly moduleId: string;
  revision: string | null = "cloud-v1";
  schemaVersion: number | null = 1;
  updatedAt = "2026-07-10T00:00:00.000Z";
  data: unknown = { value: "same" } satisfies VersionOneData;
  pushCount = 0;

  constructor(moduleId: string) {
    this.moduleId = moduleId;
  }

  async readRevision(): Promise<RemoteRevisionSnapshot | null> {
    return this.revision
      ? {
          revision: this.revision,
          updatedAt: this.updatedAt,
          schemaVersion: this.schemaVersion,
          managedFiles: ["data.json"],
          commitSha: this.revision,
        }
      : null;
  }

  async pull(): Promise<RemoteModuleSnapshot<VersionTwoData> | null> {
    const revision = await this.readRevision();
    return revision
      ? {
          ...revision,
          data: structuredClone(this.data) as VersionTwoData,
          files: new Map(),
        }
      : null;
  }

  async push(
    data: VersionTwoData,
    options: RemoteModulePushOptions,
  ): Promise<RemoteModulePushResult> {
    this.pushCount += 1;
    if (this.revision !== options.expectedRevision) {
      throw new RemoteModuleConflictError(
        options.expectedRevision,
        this.revision,
        this.updatedAt,
      );
    }
    this.revision = options.nextRevision;
    this.schemaVersion = options.schemaVersion ?? this.schemaVersion;
    this.updatedAt = options.updatedAt ?? this.updatedAt;
    this.data = structuredClone(data);
    return {
      ...(await this.readRevision())!,
      status: "committed",
    };
  }

  async overwrite(
    data: VersionTwoData,
    options: RemoteModuleOverwriteOptions,
  ): Promise<RemoteModulePushResult> {
    this.revision = options.nextRevision;
    this.schemaVersion = options.schemaVersion ?? this.schemaVersion;
    this.updatedAt = options.updatedAt ?? this.updatedAt;
    this.data = structuredClone(data);
    return {
      ...(await this.readRevision())!,
      status: "committed",
    };
  }
}

function versionedDefinition(
  moduleId: string,
): ModuleDefinition<VersionTwoData, TestEvent> {
  return {
    moduleId,
    createEmpty: () => ({
      value: "empty",
      normalized: "EMPTY",
    }),
    migration: {
      currentVersion: 2,
      migrate(value: unknown, fromVersion: number): unknown {
        if (fromVersion !== 1) {
          throw new TypeError("unsupported source schema");
        }
        const source = value as VersionOneData;
        return {
          value: source.value,
          normalized: source.value.toUpperCase(),
        } satisfies VersionTwoData;
      },
    },
    validate(value: unknown): VersionTwoData {
      const candidate = value as Partial<VersionTwoData>;
      if (
        typeof candidate?.value !== "string"
        || typeof candidate.normalized !== "string"
      ) {
        throw new TypeError("invalid current schema");
      }
      return candidate as VersionTwoData;
    },
    contentKey: jsonContentKey,
    history: {
      capacity: 10,
      apply: (payload, event) => ({
        ...payload,
        value: event.value,
        normalized: event.value.toUpperCase(),
      }),
      invert: (_event, before) => setValue(before.value),
    },
    encode: (data) => new Map([["data.json", JSON.stringify(data)]]),
    decode: (files) => JSON.parse(files.get("data.json") ?? "null") as unknown,
  };
}

async function createVersionedHarness(
  moduleId: string,
  options: {
    readonly lastSyncedContentHash?: string;
    readonly remote?: VersionedRemote;
  } = {},
) {
  const indexedDB = new IDBFactory();
  const localStore = new ModuleLocalStore<VersionTwoData>(moduleId, { indexedDB });
  const oldPayload = {
    value: "same",
  } satisfies VersionOneData;
  const oldHash = await hashContentKey(jsonContentKey(oldPayload));
  await localStore.initialize({
    ...createModuleLocalEnvelope(
      oldPayload as unknown as VersionTwoData,
      oldHash,
      "00000000-0000-4000-8000-000000000040",
      1,
    ),
    lastSyncedContentHash: options.lastSyncedContentHash ?? oldHash,
    lastSyncedRemoteRevision: "cloud-v1",
    lastSyncedRemoteUpdatedAt: "2026-07-10T00:00:00.000Z",
  });
  const remote = options.remote ?? new VersionedRemote(moduleId);
  const coordinator = new SyncCoordinator({
    definition: versionedDefinition(moduleId),
    localStore,
    remoteRepository: remote,
    operationGate: new OperationGate(),
    hooks: {
      settle: () => null,
      project: () => undefined,
      reload: () => undefined,
    },
    now: () => new Date("2026-07-10T01:00:00.000Z"),
    createUuid: () => "cloud-v2-from-this-device",
  });
  await coordinator.initialize();
  return { coordinator, localStore, remote };
}

describe("SyncCoordinator schema migration", () => {
  it("strictly rejects a versioned module whose local envelope has no schemaVersion", async () => {
    const moduleId = "module-schema-missing";
    const localStore = new ModuleLocalStore<VersionTwoData>(moduleId, {
      indexedDB: new IDBFactory(),
    });
    const payload = { value: "same" } as VersionTwoData;
    const contentHash = await hashContentKey(jsonContentKey(payload));
    await localStore.initialize(createModuleLocalEnvelope(
      payload,
      contentHash,
      "00000000-0000-4000-8000-000000000041",
    ));
    const coordinator = new SyncCoordinator({
      definition: versionedDefinition(moduleId),
      localStore,
      remoteRepository: new VersionedRemote(moduleId),
      operationGate: new OperationGate(),
      hooks: {
        settle: () => null,
        project: () => undefined,
        reload: () => undefined,
      },
    });

    await expect(coordinator.initialize()).rejects.toBeInstanceOf(
      MissingModuleSchemaVersionError,
    );
  });

  it("strictly rejects a versioned module whose remote manifest has no schemaVersion", async () => {
    const moduleId = "module-remote-schema-missing";
    const remote = new VersionedRemote(moduleId);
    remote.schemaVersion = null;
    const coordinator = new SyncCoordinator({
      definition: versionedDefinition(moduleId),
      localStore: new ModuleLocalStore<VersionTwoData>(moduleId, {
        indexedDB: new IDBFactory(),
      }),
      remoteRepository: remote,
      operationGate: new OperationGate(),
      hooks: {
        settle: () => null,
        project: () => undefined,
        reload: () => undefined,
      },
    });

    await expect(coordinator.initialize()).rejects.toMatchObject({
      name: "MissingModuleSchemaVersionError",
      source: "remote",
    });
  });

  it("atomically migrates a synced local payload and publishes the current schema", async () => {
    const { coordinator, localStore, remote } = await createVersionedHarness(
      "module-schema-publish",
    );

    expect(coordinator.history.current).toEqual({
      value: "same",
      normalized: "SAME",
    });
    expect(coordinator.getSnapshot()).toMatchObject({
      localChangedSinceSync: true,
      businessChangedSinceSync: false,
      migrationChangedSinceSync: true,
    });
    await expect(localStore.load()).resolves.toMatchObject({
      schemaVersion: 2,
      payload: { value: "same" },
      migration: {
        fromVersion: 1,
        toVersion: 2,
        businessChanged: false,
      },
    });

    await expect(
      coordinator.handleObservedRemoteRevision(await remote.readRevision()),
    ).resolves.toBe("uploaded");
    expect(remote.pushCount).toBe(1);
    expect(remote.data).toEqual({
      value: "same",
      normalized: "SAME",
    });
    expect(coordinator.getSnapshot()).toMatchObject({
      localChangedSinceSync: false,
      businessChangedSinceSync: false,
      migrationChangedSinceSync: false,
    });
  });

  it("directly confirms sync when another device published equivalent migrated data", async () => {
    const { coordinator, remote } = await createVersionedHarness(
      "module-schema-equivalent",
    );
    remote.revision = "cloud-v2-from-other-device";
    remote.schemaVersion = 2;
    remote.data = {
      value: "same",
      normalized: "SAME",
    } satisfies VersionTwoData;

    await expect(coordinator.publishMigrationIfSafe()).resolves.toBe("unchanged");
    expect(remote.pushCount).toBe(0);
    expect(coordinator.getSnapshot()).toMatchObject({
      lastSyncedRemoteRevision: "cloud-v2-from-other-device",
      localChangedSinceSync: false,
      businessChangedSinceSync: false,
      migrationChangedSinceSync: false,
      conflict: null,
    });
  });

  it("does not automatically publish when business changes predate the migration", async () => {
    const { coordinator, remote } = await createVersionedHarness(
      "module-schema-business-change",
      { lastSyncedContentHash: "older-synced-content" },
    );

    expect(coordinator.getSnapshot()).toMatchObject({
      localChangedSinceSync: true,
      businessChangedSinceSync: true,
      migrationChangedSinceSync: true,
    });
    await expect(coordinator.publishMigrationIfSafe()).resolves.toBe("unchanged");
    expect(remote.pushCount).toBe(0);
  });
});
