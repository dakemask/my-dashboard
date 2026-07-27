import type { ModuleLocalEnvelope } from "./types";

const DATABASE_PREFIX = "my-dashboard.module.";
const OBJECT_STORE_NAME = "module";
const RECORD_KEY = "state";
const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface ModuleLocalStoreOptions {
  readonly indexedDB?: IDBFactory;
}

export class LocalRevisionConflictError extends Error {
  readonly expectedLocalRevision: string | null;
  readonly actualLocalRevision: string | null;

  constructor(
    expectedLocalRevision: string | null,
    actualLocalRevision: string | null,
  ) {
    super(
      `Local revision changed (expected ${expectedLocalRevision ?? "no record"}, ` +
        `found ${actualLocalRevision ?? "no record"}).`,
    );
    this.name = "LocalRevisionConflictError";
    this.expectedLocalRevision = expectedLocalRevision;
    this.actualLocalRevision = actualLocalRevision;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed.")),
      { once: true },
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")),
      { once: true },
    );
  });
}

function validateRevision(revision: string, label: string): void {
  if (typeof revision !== "string" || revision.length === 0) {
    throw new TypeError(`${label} must be a non-empty UUID string.`);
  }
}

/**
 * One database and one atomically replaced record per module. There are no
 * cross-module transactions in this boundary. Business migration rules stay in
 * the module definition; this store only persists their runtime state.
 */
export class ModuleLocalStore<T> {
  readonly moduleId: string;
  readonly databaseName: string;
  readonly #indexedDB: IDBFactory;
  #databasePromise: Promise<IDBDatabase> | null = null;

  constructor(moduleId: string, options: ModuleLocalStoreOptions = {}) {
    if (!MODULE_ID_PATTERN.test(moduleId)) {
      throw new TypeError(`Invalid moduleId: ${moduleId}`);
    }

    const indexedDBFactory = options.indexedDB ?? globalThis.indexedDB;
    if (indexedDBFactory === undefined) {
      throw new Error("IndexedDB is required for module persistence.");
    }

    this.moduleId = moduleId;
    this.databaseName = `${DATABASE_PREFIX}${moduleId}`;
    this.#indexedDB = indexedDBFactory;
  }

  async load(): Promise<ModuleLocalEnvelope<T> | null> {
    const database = await this.#openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, "readonly");
    const completion = transactionDone(transaction);
    const result = await requestResult(
      transaction.objectStore(OBJECT_STORE_NAME).get(RECORD_KEY),
    );
    await completion;
    const stored = result as ModuleLocalEnvelope<T> | undefined;
    return stored ? normalizeEnvelope(stored) : null;
  }

  /**
   * Replaces the complete module envelope if the record still has the expected
   * local revision. `null` means the database must not have a record yet.
   */
  async compareAndSwap(
    expectedLocalRevision: string | null,
    next: ModuleLocalEnvelope<T>,
  ): Promise<ModuleLocalEnvelope<T>> {
    const stored = structuredClone(next);
    validateRevision(stored.localRevision, "next.localRevision");
    if (stored.localRevision === expectedLocalRevision) {
      throw new TypeError("A successful write must use a new local revision.");
    }

    const database = await this.#openDatabase();
    return new Promise<ModuleLocalEnvelope<T>>((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE_NAME, "readwrite");
      const store = transaction.objectStore(OBJECT_STORE_NAME);
      let failure: unknown;
      let putStarted = false;

      transaction.addEventListener(
        "complete",
        () => {
          if (putStarted) {
            resolve(structuredClone(stored));
          } else {
            reject(failure ?? new Error("IndexedDB write completed unexpectedly."));
          }
        },
        { once: true },
      );
      transaction.addEventListener(
        "abort",
        () => reject(failure ?? transaction.error ?? new Error("IndexedDB write aborted.")),
        { once: true },
      );
      transaction.addEventListener(
        "error",
        () => {
          failure ??= transaction.error ?? new Error("IndexedDB write failed.");
        },
        { once: true },
      );

      const getRequest = store.get(RECORD_KEY);
      getRequest.addEventListener(
        "error",
        () => {
          failure = getRequest.error ?? new Error("Could not read the module record.");
        },
        { once: true },
      );
      getRequest.addEventListener(
        "success",
        () => {
          const current = getRequest.result as ModuleLocalEnvelope<T> | undefined;
          const actualRevision = current?.localRevision ?? null;
          if (actualRevision !== expectedLocalRevision) {
            failure = new LocalRevisionConflictError(
              expectedLocalRevision,
              actualRevision,
            );
            transaction.abort();
            return;
          }

          try {
            const putRequest = store.put(stored, RECORD_KEY);
            putStarted = true;
            putRequest.addEventListener(
              "error",
              () => {
                failure = putRequest.error ?? new Error("Could not write the module record.");
              },
              { once: true },
            );
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        },
        { once: true },
      );
    });
  }

  save(
    next: ModuleLocalEnvelope<T>,
    expectedLocalRevision: string | null,
  ): Promise<ModuleLocalEnvelope<T>> {
    return this.compareAndSwap(expectedLocalRevision, next);
  }

  initialize(next: ModuleLocalEnvelope<T>): Promise<ModuleLocalEnvelope<T>> {
    return this.compareAndSwap(null, next);
  }

  close(): void {
    const databasePromise = this.#databasePromise;
    this.#databasePromise = null;
    if (databasePromise !== null) {
      void databasePromise.then((database) => database.close());
    }
  }

  async deleteDatabase(): Promise<void> {
    this.close();
    const request = this.#indexedDB.deleteDatabase(this.databaseName);
    await requestResult(request);
  }

  #openDatabase(): Promise<IDBDatabase> {
    if (this.#databasePromise !== null) {
      return this.#databasePromise;
    }

    this.#databasePromise = new Promise((resolve, reject) => {
      const request = this.#indexedDB.open(this.databaseName, 1);
      request.addEventListener(
        "upgradeneeded",
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
            database.createObjectStore(OBJECT_STORE_NAME);
          }
        },
        { once: true },
      );
      request.addEventListener(
        "success",
        () => {
          const database = request.result;
          database.addEventListener("versionchange", () => {
            database.close();
            this.#databasePromise = null;
          });
          resolve(database);
        },
        { once: true },
      );
      request.addEventListener(
        "error",
        () => {
          this.#databasePromise = null;
          reject(request.error ?? new Error("Could not open the module database."));
        },
        { once: true },
      );
      request.addEventListener(
        "blocked",
        () => {
          this.#databasePromise = null;
          reject(new Error("Opening the module database was blocked."));
        },
        { once: true },
      );
    });

    return this.#databasePromise;
  }
}

/**
 * Version-one databases predate the display timestamps. Keep the database and
 * record shape backward compatible by filling only absent optional metadata at
 * the read boundary.
 */
function normalizeEnvelope<T>(stored: ModuleLocalEnvelope<T>): ModuleLocalEnvelope<T> {
  return {
    ...stored,
    schemaVersion: stored.schemaVersion ?? null,
    localSavedAt: stored.localSavedAt ?? null,
    lastSyncedRemoteUpdatedAt: stored.lastSyncedRemoteUpdatedAt ?? null,
    conflict: stored.conflict
      ? {
          ...stored.conflict,
          observedRemoteUpdatedAt: stored.conflict.observedRemoteUpdatedAt ?? null,
        }
      : null,
    migration: stored.migration ?? null,
  };
}
