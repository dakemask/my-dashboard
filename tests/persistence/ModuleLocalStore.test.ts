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
    lastSyncedContentHash: null,
    lastSyncedRemoteRevision: null,
    pendingUpload: null,
    conflict: null,
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

  it("atomically replaces the complete envelope using CAS", async () => {
    const store = new ModuleLocalStore<Payload>("atomic", { indexedDB: factory });
    const firstRevision = "00000000-0000-4000-8000-000000000001";
    const secondRevision = "00000000-0000-4000-8000-000000000002";
    await store.initialize(envelope("A", firstRevision));

    const next = envelope("B", secondRevision, {
      lastSyncedContentHash: "hash-A",
      lastSyncedRemoteRevision: "10000000-0000-4000-8000-000000000001",
      pendingUpload: {
        localRevision: secondRevision,
        contentHash: "hash-B",
        nextRemoteRevision: "20000000-0000-4000-8000-000000000001",
        updatedAt: "2026-07-10T09:00:00.000Z",
      },
      conflict: {
        observedRemoteRevision: "30000000-0000-4000-8000-000000000001",
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

  it("retains pending upload and conflict information after reopening", async () => {
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
        detectedAt: "2026-07-10T09:01:00.000Z",
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
});
