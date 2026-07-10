import { OperationGate } from "../concurrency";
import {
  RemoteModuleConflictError,
  type RemoteRevisionSnapshot,
} from "../github";
import { StagingHistory } from "../history";
import {
  ModuleLocalStore,
  createLocalRevision,
  createModuleLocalEnvelope,
  type ModuleLocalEnvelope,
  type PersistedConflict,
} from "../persistence";
import { hashJsonPayload } from "./contentHash";
import {
  LocalDataIntegrityError,
  SyncConflictPendingError,
  SyncCoordinatorNotInitializedError,
  type ConflictResolution,
  type ModuleDefinition,
  type RemoteModulePort,
  type SettleReason,
  type SyncActionResult,
  type SyncCoordinatorHooks,
  type SyncCoordinatorSnapshot,
} from "./types";

interface SyncCoordinatorOptions<T> {
  definition: ModuleDefinition<T>;
  localStore: ModuleLocalStore<T>;
  remoteRepository: RemoteModulePort<T>;
  operationGate: OperationGate;
  hooks: SyncCoordinatorHooks<T>;
  now?: () => Date;
  createUuid?: () => string;
}

export class SyncCoordinator<T> {
  readonly #definition: ModuleDefinition<T>;
  readonly #localStore: ModuleLocalStore<T>;
  readonly #remoteRepository: RemoteModulePort<T>;
  readonly #operationGate: OperationGate;
  readonly #hooks: SyncCoordinatorHooks<T>;
  readonly #now: () => Date;
  readonly #createUuid: () => string;
  #history: StagingHistory<T> | null = null;
  #local: ModuleLocalEnvelope<T> | null = null;

  constructor(options: SyncCoordinatorOptions<T>) {
    if (options.definition.moduleId !== options.remoteRepository.moduleId) {
      throw new TypeError("The module definition and remote repository must use the same moduleId.");
    }

    if (options.definition.moduleId !== options.localStore.moduleId) {
      throw new TypeError("The module definition and local store must use the same moduleId.");
    }

    this.#definition = options.definition;
    this.#localStore = options.localStore;
    this.#remoteRepository = options.remoteRepository;
    this.#operationGate = options.operationGate;
    this.#hooks = options.hooks;
    this.#now = options.now ?? (() => new Date());
    this.#createUuid = options.createUuid ?? (() => crypto.randomUUID());
  }

  get history(): StagingHistory<T> {
    this.#assertInitialized();
    return this.#history!;
  }

  getSnapshot(): SyncCoordinatorSnapshot {
    if (!this.#history || !this.#local) {
      return {
        initialized: false,
        sessionDirty: false,
        localChangedSinceSync: false,
        lastSyncedRemoteRevision: null,
        pendingUpload: null,
        conflict: null,
      };
    }

    return {
      initialized: true,
      sessionDirty: this.#history.dirty,
      localChangedSinceSync: this.#local.contentHash !== this.#local.lastSyncedContentHash,
      lastSyncedRemoteRevision: this.#local.lastSyncedRemoteRevision,
      pendingUpload: this.#local.pendingUpload,
      conflict: this.#local.conflict,
    };
  }

  async initialize(): Promise<T> {
    if (this.#history) {
      return this.#history.current;
    }

    let local = await this.#localStore.load();
    if (local) {
      const payload = this.#definition.validate(local.payload);
      if (await hashJsonPayload(payload) !== local.contentHash) {
        throw new LocalDataIntegrityError();
      }
      local = { ...local, payload };
    } else {
      local = await this.#operationGate.runCloud(async () => {
        const remote = await this.#remoteRepository.pull();
        const payload = this.#definition.validate(remote?.data ?? this.#definition.createEmpty());
        const contentHash = await hashJsonPayload(payload);
        const initial = {
          ...createModuleLocalEnvelope(payload, contentHash),
          lastSyncedContentHash: contentHash,
          lastSyncedRemoteRevision: remote?.revision ?? null,
        };
        return this.#localStore.initialize(initial);
      });
    }

    this.#local = local;
    this.#history = new StagingHistory(local.payload);
    this.#hooks.project(this.#history.current, "initialize");
    if (local.conflict) {
      this.#hooks.onConflict?.(local.conflict);
    }
    return this.#history.current;
  }

  commit(payload: T): T {
    this.#assertInitialized();
    return this.#history!.commit(this.#definition.validate(payload));
  }

  async undo(): Promise<T> {
    await this.#settleAndCommit("undo");
    const payload = this.history.undo();
    this.#hooks.project(payload, "undo");
    return payload;
  }

  async redo(): Promise<T> {
    await this.#settleAndCommit("redo");
    const payload = this.history.redo();
    this.#hooks.project(payload, "redo");
    return payload;
  }

  async saveLocal(): Promise<SyncActionResult> {
    this.#assertInitialized();
    return this.#operationGate.runLocal(async () => {
      await this.#settleAndCommit("local-save");
      return this.#saveCurrentInsideGate();
    });
  }

  async upload(): Promise<SyncActionResult> {
    this.#assertInitialized();
    return this.#operationGate.runCloud(async () => {
      await this.#settleAndCommit("upload");
      if (this.history.dirty) {
        await this.#saveCurrentInsideGate();
      }

      let observed = await this.#remoteRepository.readRevision();
      observed = await this.#reconcilePendingUpload(observed);

      if (this.#local!.conflict) {
        throw new SyncConflictPendingError(this.#local!.conflict.observedRemoteRevision);
      }

      if ((observed?.revision ?? null) !== this.#local!.lastSyncedRemoteRevision) {
        if (this.#hasLocalChanges()) {
          await this.#recordConflict(observed?.revision ?? null);
          throw new SyncConflictPendingError(observed?.revision ?? null);
        }
        return this.#pullInsideGate();
      }

      if (this.#local!.contentHash === this.#local!.lastSyncedContentHash) {
        return "unchanged";
      }

      return this.#pushInsideGate(false);
    });
  }

  async pull(): Promise<SyncActionResult> {
    this.#assertInitialized();
    return this.#operationGate.runCloud(async () => {
      if (this.#local!.conflict) {
        return "conflict";
      }

      let remote = await this.#remoteRepository.readRevision();
      try {
        remote = await this.#reconcilePendingUpload(remote);
      } catch (error) {
        if (error instanceof SyncConflictPendingError) {
          return "conflict";
        }
        throw error;
      }

      if ((remote?.revision ?? null) === this.#local!.lastSyncedRemoteRevision) {
        return "unchanged";
      }

      if (this.#hasLocalChanges()) {
        await this.#recordConflict(remote?.revision ?? null);
        return "conflict";
      }
      return this.#pullInsideGate();
    });
  }

  async resolveConflict(strategy: ConflictResolution): Promise<SyncActionResult> {
    this.#assertInitialized();
    return this.#operationGate.runCloud(async () => {
      if (strategy === "cloud-wins") {
        return this.#pullInsideGate();
      }

      await this.#settleAndCommit("upload");
      if (this.history.dirty) {
        await this.#saveCurrentInsideGate();
      }
      return this.#pushInsideGate(true);
    });
  }

  async handleObservedRemoteRevision(remoteRevision: string | null): Promise<SyncActionResult> {
    this.#assertInitialized();
    if (this.#operationGate.busy) {
      return "busy";
    }

    if (this.#local!.pendingUpload?.nextRemoteRevision === remoteRevision) {
      return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
        await this.#confirmPendingUpload(remoteRevision);
        return "uploaded";
      });
    }

    if (this.#local!.conflict) {
      if (this.#local!.conflict.observedRemoteRevision !== remoteRevision) {
        return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
          await this.#recordConflict(remoteRevision);
          return "conflict";
        });
      }
      return "conflict";
    }

    if (remoteRevision === this.#local!.lastSyncedRemoteRevision) {
      return "unchanged";
    }

    if (this.#hasLocalChanges()) {
      return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
        await this.#recordConflict(remoteRevision);
        return "conflict";
      });
    }

    return this.#operationGate.runCloud(() => this.#pullInsideGate());
  }

  close(): void {
    this.#localStore.close();
  }

  async #saveCurrentInsideGate(): Promise<SyncActionResult> {
    if (!this.history.dirty) {
      return "unchanged";
    }

    const payload = this.history.current;
    const contentHash = await hashJsonPayload(payload);
    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      payload,
      contentHash,
      localRevision: nextLocalRevision,
    }));
    this.history.updateBaseline(payload);
    return "saved";
  }

  async #pushInsideGate(overwrite: boolean): Promise<SyncActionResult> {
    let pending = this.#local!.pendingUpload;
    if (!pending || pending.contentHash !== this.#local!.contentHash) {
      const nextLocalRevision = createLocalRevision();
      pending = {
        localRevision: nextLocalRevision,
        contentHash: this.#local!.contentHash,
        nextRemoteRevision: this.#createUuid(),
        updatedAt: this.#now().toISOString(),
      };
      const next = { ...this.#local!, localRevision: nextLocalRevision, pendingUpload: pending };
      this.#local = await this.#localStore.compareAndSwap(this.#local!.localRevision, next);
    }

    try {
      const result = overwrite
        ? await this.#remoteRepository.overwrite(this.#local!.payload, {
            nextRevision: pending.nextRemoteRevision,
            updatedAt: pending.updatedAt,
          })
        : await this.#remoteRepository.push(this.#local!.payload, {
            expectedRevision: this.#local!.lastSyncedRemoteRevision,
            nextRevision: pending.nextRemoteRevision,
            updatedAt: pending.updatedAt,
          });

      await this.#confirmPendingUpload(result.revision);
      return "uploaded";
    } catch (error) {
      if (error instanceof RemoteModuleConflictError) {
        await this.#recordConflict(error.actualRevision);
        throw new SyncConflictPendingError(error.actualRevision);
      }
      throw error;
    }
  }

  async #reconcilePendingUpload(
    observed: RemoteRevisionSnapshot | null,
  ): Promise<RemoteRevisionSnapshot | null> {
    const pending = this.#local!.pendingUpload;
    if (!pending) {
      return observed;
    }

    if (observed?.revision === pending.nextRemoteRevision) {
      await this.#confirmPendingUpload(observed.revision);
      return observed;
    }

    if ((observed?.revision ?? null) !== this.#local!.lastSyncedRemoteRevision) {
      await this.#recordConflict(observed?.revision ?? null);
      throw new SyncConflictPendingError(observed?.revision ?? null);
    }

    if (pending.contentHash !== this.#local!.contentHash) {
      await this.#writeLocal((local, nextLocalRevision) => ({
        ...local,
        localRevision: nextLocalRevision,
        pendingUpload: null,
      }));
    }
    return observed;
  }

  async #confirmPendingUpload(remoteRevision: string): Promise<void> {
    const pending = this.#local!.pendingUpload;
    if (!pending) {
      return;
    }

    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      lastSyncedContentHash: pending.contentHash,
      lastSyncedRemoteRevision: remoteRevision,
      pendingUpload: null,
      conflict: null,
    }));
  }

  async #pullInsideGate(): Promise<SyncActionResult> {
    const remote = await this.#remoteRepository.pull();
    const payload = this.#definition.validate(remote?.data ?? this.#definition.createEmpty());
    const contentHash = await hashJsonPayload(payload);
    await this.#writeLocal((_local, nextLocalRevision) => ({
      payload,
      contentHash,
      localRevision: nextLocalRevision,
      lastSyncedContentHash: contentHash,
      lastSyncedRemoteRevision: remote?.revision ?? null,
      pendingUpload: null,
      conflict: null,
    }));
    this.#hooks.reload();
    return "reloaded";
  }

  async #recordConflict(remoteRevision: string | null): Promise<PersistedConflict> {
    const existing = this.#local!.conflict;
    if (existing?.observedRemoteRevision === remoteRevision) {
      return existing;
    }

    const conflict: PersistedConflict = {
      observedRemoteRevision: remoteRevision,
      detectedAt: this.#now().toISOString(),
    };
    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      conflict,
    }));
    this.#hooks.onConflict?.(conflict);
    return conflict;
  }

  async #writeLocal(
    createNext: (current: ModuleLocalEnvelope<T>, nextLocalRevision: string) => ModuleLocalEnvelope<T>,
  ): Promise<void> {
    const current = this.#local!;
    const next = createNext(current, createLocalRevision());
    this.#local = await this.#localStore.compareAndSwap(current.localRevision, next);
  }

  #hasLocalChanges(): boolean {
    return this.history.dirty || this.#local!.contentHash !== this.#local!.lastSyncedContentHash;
  }

  async #settleAndCommit(reason: SettleReason): Promise<void> {
    this.#assertInitialized();
    const pendingPayload = await this.#hooks.settle(reason);
    if (pendingPayload !== null) {
      this.commit(pendingPayload);
    }
  }

  #assertInitialized(): void {
    if (!this.#history || !this.#local) {
      throw new SyncCoordinatorNotInitializedError();
    }
  }
}
