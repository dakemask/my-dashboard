import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import {
  LocalRevisionConflictError,
  ModuleLocalStore,
  type ModuleLocalEnvelope,
} from "../../src/shared/persistence";

interface Payload {
  readonly value: string;
}

function envelope(
  value: string,
  localRevision: string,
  overrides: Partial<ModuleLocalEnvelope<Payload>> = {},
): ModuleLocalEnvelope<Payload> {
  return {
    payload: { value },
    contentHash: `hash-${value}`,
    localRevision,
    localSavedAt: null,
    lastSyncedContentHash: null,
    lastSyncedRemoteRevision: null,
    lastSyncedRemoteUpdatedAt: null,
    pendingUpload: null,
    conflict: null,
    migration: null,
    ...overrides,
  };
}

describe("ModuleLocalStore", () => {
  let factory: IDBFactory;

  beforeEach(() => {
    factory = new IDBFactory();
  });

  it("rejects module identifiers that begin with a number", () => {
    expect(() => new ModuleLocalStore("1-notes", { indexedDB: factory })).toThrow(TypeError);
  });

  it("isolates modules in independently named databases", async () => {
    const alpha = new ModuleLocalStore<Payload>("alpha", { indexedDB: factory });
    const beta = new ModuleLocalStore<Payload>("beta", { indexedDB: factory });

    await alpha.initialize(envelope("alpha", "00000000-0000-4000-8000-000000000001"));
    await beta.initialize(envelope("beta", "00000000-0000-4000-8000-000000000002"));

    expect(alpha.databaseName).toBe("my-dashboard.module.alpha");
    expect(beta.databaseName).toBe("my-dashboard.module.beta");
    expect((await alpha.load())?.payload.value).toBe("alpha");
    expect((await beta.load())?.payload.value).toBe("beta");
  });

  it("stores non-JSON structured-clone payloads without retaining caller aliases", async () => {
    interface RichPayload {
      readonly createdAt: Date;
      readonly assets: Map<string, Uint8Array>;
    }

    const store = new ModuleLocalStore<RichPayload>("rich-data", { indexedDB: factory });
    const payload: RichPayload = {
      createdAt: new Date("2026-07-11T00:00:00.000Z"),
      assets: new Map([["icon", new Uint8Array([1, 2, 3])]]),
    };
    const record: ModuleLocalEnvelope<RichPayload> = {
      payload,
      contentHash: "rich-hash",
      localRevision: "00000000-0000-4000-8000-000000000010",
      localSavedAt: null,
      lastSyncedContentHash: null,
      lastSyncedRemoteRevision: null,
      lastSyncedRemoteUpdatedAt: null,
      pendingUpload: null,
      conflict: null,
      migration: null,
    };

    await store.initialize(record);
    payload.assets.get("icon")![0] = 9;

    const loaded = await store.load();
    expect(loaded?.payload.createdAt).toBeInstanceOf(Date);
    expect(loaded?.payload.assets).toBeInstanceOf(Map);
    expect([...loaded!.payload.assets.get("icon")!]).toEqual([1, 2, 3]);
  });

  it("atomically replaces the complete envelope using CAS", async () => {
    const store = new ModuleLocalStore<Payload>("atomic", { indexedDB: factory });
    const firstRevision = "00000000-0000-4000-8000-000000000001";
    const secondRevision = "00000000-0000-4000-8000-000000000002";
    await store.initialize(envelope("A", firstRevision));

    const next = envelope("B", secondRevision, {
      localSavedAt: "2026-07-10T08:59:00.000Z",
      lastSyncedContentHash: "hash-A",
      lastSyncedRemoteRevision: "10000000-0000-4000-8000-000000000001",
      lastSyncedRemoteUpdatedAt: "2026-07-10T08:58:00.000Z",
      pendingUpload: {
        localRevision: secondRevision,
        contentHash: "hash-B",
        nextRemoteRevision: "20000000-0000-4000-8000-000000000001",
        updatedAt: "2026-07-10T09:00:00.000Z",
      },
      conflict: {
        observedRemoteRevision: "30000000-0000-4000-8000-000000000001",
        observedRemoteUpdatedAt: "2026-07-10T09:00:30.000Z",
        detectedAt: "2026-07-10T09:01:00.000Z",
      },
    });
    await store.compareAndSwap(firstRevision, next);

    expect(await store.load()).toEqual(next);
    expect(await store.load()).not.toHaveProperty("schemaVersion");
  });

  it("rejects a stale writer without changing the stored record", async () => {
    const first = new ModuleLocalStore<Payload>("cas", { indexedDB: factory });
    const second = new ModuleLocalStore<Payload>("cas", { indexedDB: factory });
    const revisionA = "00000000-0000-4000-8000-000000000001";
    const revisionB = "00000000-0000-4000-8000-000000000002";
    await first.initialize(envelope("A", revisionA));
    await first.compareAndSwap(revisionA, envelope("B", revisionB));

    await expect(
      second.compareAndSwap(
        revisionA,
        envelope("stale", "00000000-0000-4000-8000-000000000003"),
      ),
    ).rejects.toMatchObject({
      name: "LocalRevisionConflictError",
      expectedLocalRevision: revisionA,
      actualLocalRevision: revisionB,
    } satisfies Partial<LocalRevisionConflictError>);
    expect(await second.load()).toEqual(envelope("B", revisionB));
  });

  it("does not advance the stored baseline when cloning a write fails", async () => {
    const store = new ModuleLocalStore<Payload>("failure", { indexedDB: factory });
    const revisionA = "00000000-0000-4000-8000-000000000001";
    await store.initialize(envelope("A", revisionA));

    const invalid = envelope(
      "B",
      "00000000-0000-4000-8000-000000000002",
    ) as unknown as ModuleLocalEnvelope<Payload & { invalid: () => void }>;
    (invalid.payload as { invalid?: () => void }).invalid = () => undefined;

    await expect(
      (store as unknown as ModuleLocalStore<Payload & { invalid: () => void }>).compareAndSwap(
        revisionA,
        invalid,
      ),
    ).rejects.toBeDefined();
    expect(await store.load()).toEqual(envelope("A", revisionA));
  });

  it("retains pending upload, conflict, and migration information after reopening", async () => {
    const moduleId = "resume-state";
    const firstRevision = "00000000-0000-4000-8000-000000000001";
    const stored = envelope("A", firstRevision, {
      pendingUpload: {
        localRevision: firstRevision,
        contentHash: "hash-A",
        nextRemoteRevision: "20000000-0000-4000-8000-000000000001",
        updatedAt: "2026-07-10T09:00:00.000Z",
      },
      conflict: {
        observedRemoteRevision: null,
        observedRemoteUpdatedAt: null,
        detectedAt: "2026-07-10T09:01:00.000Z",
      },
      migration: {
        fromVersion: 1,
        toVersion: 2,
        migratedContentHash: "hash-A",
        businessChanged: true,
      },
    });
    const beforeRefresh = new ModuleLocalStore<Payload>(moduleId, {
      indexedDB: factory,
    });
    await beforeRefresh.initialize(stored);
    beforeRefresh.close();

    const afterRefresh = new ModuleLocalStore<Payload>(moduleId, {
      indexedDB: factory,
    });
    expect(await afterRefresh.load()).toEqual(stored);
  });

  it("normalizes timestamp fields missing from a version-one record without upgrading the database", async () => {
    const store = new ModuleLocalStore<Payload>("legacy-timestamps", {
      indexedDB: factory,
    });
    const legacy = {
      payload: { value: "legacy" },
      contentHash: "hash-legacy",
      localRevision: "00000000-0000-4000-8000-000000000020",
      lastSyncedContentHash: "hash-legacy",
      lastSyncedRemoteRevision: "10000000-0000-4000-8000-000000000020",
      pendingUpload: null,
      conflict: {
        observedRemoteRevision: "20000000-0000-4000-8000-000000000020",
        detectedAt: "2026-07-09T00:00:00.000Z",
      },
    } as unknown as ModuleLocalEnvelope<Payload>;

    await store.initialize(legacy);

    await expect(store.load()).resolves.toMatchObject({
      localSavedAt: null,
      lastSyncedRemoteUpdatedAt: null,
      conflict: { observedRemoteUpdatedAt: null },
    });
    const openRequest = factory.open(store.databaseName);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      openRequest.addEventListener("success", () => resolve(openRequest.result), { once: true });
      openRequest.addEventListener("error", () => reject(openRequest.error), { once: true });
    });
    expect(database.version).toBe(1);
    database.close();
  });
});
