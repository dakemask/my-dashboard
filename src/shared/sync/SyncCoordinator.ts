import { OperationGate } from "../concurrency";
import {
  RemoteModuleConflictError,
  type RemoteRevisionSnapshot,
} from "../github";
import { StagingHistory } from "../history";
import { ModuleLocalStore } from "../persistence";
import {
  hashModulePayload,
  prepareStoredModulePayload,
} from "./modulePayload";
import {
  SyncSessionState,
  type ObservedRemoteVersion,
} from "./SyncSessionState";
import {
  LocalDataIntegrityError,
  MissingModuleSchemaVersionError,
  ModuleMigrationError,
  SyncConflictPendingError,
  SyncCoordinatorNotInitializedError,
  UnsupportedModuleSchemaVersionError,
  type ConflictResolution,
  type ModuleDefinition,
  type RemoteModulePort,
  type SettleReason,
  type SyncActionResult,
  type SyncCoordinatorHooks,
  type SyncCoordinatorSnapshot,
} from "./types";

interface SyncCoordinatorOptions<T, E> {
  definition: ModuleDefinition<T, E>;
  localStore: ModuleLocalStore<T>;
  remoteRepository: RemoteModulePort<T>;
  operationGate: OperationGate;
  hooks: SyncCoordinatorHooks<T, E>;
  now?: () => Date;
  createUuid?: () => string;
}

export class SyncCoordinator<T, E> {
  readonly #definition: ModuleDefinition<T, E>;
  readonly #remoteRepository: RemoteModulePort<T>;
  readonly #operationGate: OperationGate;
  readonly #hooks: SyncCoordinatorHooks<T, E>;
  readonly #now: () => Date;
  readonly #createUuid: () => string;
  readonly #session: SyncSessionState<T, E>;

  constructor(options: SyncCoordinatorOptions<T, E>) {
    if (options.definition.moduleId !== options.remoteRepository.moduleId) {
      throw new TypeError("The module definition and remote repository must use the same moduleId.");
    }

    if (options.definition.moduleId !== options.localStore.moduleId) {
      throw new TypeError("The module definition and local store must use the same moduleId.");
    }

    this.#definition = options.definition;
    this.#remoteRepository = options.remoteRepository;
    this.#operationGate = options.operationGate;
    this.#hooks = options.hooks;
    this.#now = options.now ?? (() => new Date());
    this.#createUuid = options.createUuid ?? (() => crypto.randomUUID());
    this.#session = new SyncSessionState({
      definition: options.definition,
      localStore: options.localStore,
      now: this.#now,
      onConflict: options.hooks.onConflict,
    });
  }

  get history(): StagingHistory<T, E> {
    this.#assertInitialized();
    return this.#session.history;
  }

  getSnapshot(): SyncCoordinatorSnapshot {
    return this.#session.getSnapshot();
  }

  async initialize(): Promise<T> {
    if (this.#session.initialized) {
      return this.#session.history.current;
    }

    const local = await this.#session.load();
    if (local) {
      const prepared = prepareStoredModulePayload(
        this.#definition,
        local.payload,
        local.schemaVersion,
        "local",
      );
      const contentHash = await hashModulePayload(this.#definition, prepared.payload);
      if (!prepared.migrated && contentHash !== local.contentHash) {
        throw new LocalDataIntegrityError();
      }
      await this.#session.openLoaded(local, prepared, contentHash);
    } else {
      await this.#operationGate.runCloud(async () => {
        const remote = await this.#remoteRepository.pull();
        const prepared = prepareStoredModulePayload(
          this.#definition,
          remote?.data ?? this.#definition.createEmpty(),
          remote
            ? remote.schemaVersion ?? null
            : this.#definition.migration?.currentVersion ?? null,
          "remote",
        );
        const contentHash = await hashModulePayload(this.#definition, prepared.payload);
        await this.#session.initializeNew(
          prepared,
          contentHash,
          toObservedRemoteVersion(remote),
        );
      });
    }

    this.#hooks.project(this.history.current, "initialize");
    this.#session.notifyPersistedConflict();
    return this.history.current;
  }

  dispatch(event: E): T {
    this.#assertInitialized();
    return this.#session.dispatch(event);
  }

  async undo(): Promise<T> {
    await this.#settleAndDispatch("undo");
    const payload = this.history.undo();
    this.#hooks.project(payload, "undo");
    return payload;
  }

  async redo(): Promise<T> {
    await this.#settleAndDispatch("redo");
    const payload = this.history.redo();
    this.#hooks.project(payload, "redo");
    return payload;
  }

  async saveLocal(): Promise<SyncActionResult> {
    this.#assertInitialized();
    return this.#operationGate.runLocal(async () => {
      await this.#settleAndDispatch("local-save");
      return this.#saveCurrentInsideGate();
    });
  }

  async upload(): Promise<SyncActionResult> {
    this.#assertInitialized();
    return this.#operationGate.runCloud(async () => {
      await this.#settleAndDispatch("upload");
      if (this.history.dirty) {
        await this.#saveCurrentInsideGate();
      }

      let observed = await this.#remoteRepository.readRevision();
      this.#assertRemoteSchemaVersion(observed);
      observed = await this.#reconcilePendingUpload(observed);

      const conflict = this.#session.conflict;
      if (conflict) {
        throw new SyncConflictPendingError(conflict.observedRemoteRevision);
      }

      if ((observed?.revision ?? null) !== this.#session.lastSyncedRemoteRevision) {
        if (this.#session.hasLocalChanges()) {
          if (await this.#confirmEquivalentRemoteMigration()) {
            return "unchanged";
          }
          await this.#session.recordConflict(toObservedRemoteVersion(observed));
          throw new SyncConflictPendingError(observed?.revision ?? null);
        }
        return this.#pullInsideGate();
      }

      await this.#session.backfillSyncedRemoteUpdatedAt(observed);

      if (this.#session.isContentSynced()) {
        return "unchanged";
      }

      return this.#pushInsideGate(false);
    });
  }

  async pull(): Promise<SyncActionResult> {
    this.#assertInitialized();
    return this.#operationGate.runCloud(async () => {
      if (this.#session.conflict) {
        return "conflict";
      }

      let remote = await this.#remoteRepository.readRevision();
      this.#assertRemoteSchemaVersion(remote);
      try {
        remote = await this.#reconcilePendingUpload(remote);
      } catch (error) {
        if (error instanceof SyncConflictPendingError) {
          return "conflict";
        }
        throw error;
      }

      if ((remote?.revision ?? null) === this.#session.lastSyncedRemoteRevision) {
        await this.#session.backfillSyncedRemoteUpdatedAt(remote);
        return "unchanged";
      }

      await this.#settleAndDispatch("pull");
      if (this.#session.hasLocalChanges()) {
        if (await this.#confirmEquivalentRemoteMigration()) {
          return "unchanged";
        }
        await this.#session.recordConflict(toObservedRemoteVersion(remote));
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

      await this.#settleAndDispatch("upload");
      if (this.history.dirty) {
        await this.#saveCurrentInsideGate();
      }
      return this.#pushInsideGate(true);
    });
  }

  async handleObservedRemoteRevision(
    observed: RemoteRevisionSnapshot | null,
  ): Promise<SyncActionResult> {
    this.#assertInitialized();
    this.#assertRemoteSchemaVersion(observed);
    if (this.#operationGate.busy) {
      return "busy";
    }

    const remoteRevision = observed?.revision ?? null;
    if (this.#session.pendingUpload?.nextRemoteRevision === remoteRevision) {
      return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
        await this.#session.confirmPendingUpload(toObservedRemoteVersion(observed));
        return "uploaded";
      });
    }

    const conflict = this.#session.conflict;
    if (conflict) {
      const remoteVersion = toObservedRemoteVersion(observed);
      const revisionChanged = conflict.observedRemoteRevision !== remoteVersion.revision;
      if (
        revisionChanged
        || (
          remoteVersion.updatedAt !== null
          && conflict.observedRemoteUpdatedAt !== remoteVersion.updatedAt
        )
      ) {
        if (revisionChanged) await this.#settleAndDispatch("remote-change");
        return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
          await this.#session.recordConflict(remoteVersion);
          return "conflict";
        });
      }
      return "conflict";
    }

    if (remoteRevision === this.#session.lastSyncedRemoteRevision) {
      if (this.#session.hasOnlyMigrationChanges()) {
        return this.publishMigrationIfSafe();
      }
      if (this.#session.needsSyncedRemoteTimestampBackfill(observed)) {
        return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
          await this.#session.backfillSyncedRemoteUpdatedAt(observed);
          return "unchanged";
        });
      }
      return "unchanged";
    }

    await this.#settleAndDispatch("remote-change");
    if (this.#session.hasLocalChanges()) {
      if (this.#session.hasOnlyMigrationChanges()) {
        return this.#operationGate.runCloud(async (): Promise<SyncActionResult> => {
          if (await this.#confirmEquivalentRemoteMigration()) {
            return "unchanged";
          }
          await this.#session.recordConflict(toObservedRemoteVersion(observed));
          return "conflict";
        });
      }
      return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
        await this.#session.recordConflict(toObservedRemoteVersion(observed));
        return "conflict";
      });
    }

    return this.#operationGate.runCloud(() => this.#pullInsideGate());
  }

  close(): void {
    this.#session.close();
  }

  /**
   * Best-effort automatic publication for a pure local schema migration. It
   * never settles UI state and therefore stops as soon as business edits exist.
   */
  async publishMigrationIfSafe(): Promise<SyncActionResult> {
    this.#assertInitialized();
    if (!this.#session.hasOnlyMigrationChanges()) {
      return "unchanged";
    }

    return this.#operationGate.runCloud(async () => {
      let observed = await this.#remoteRepository.readRevision();
      this.#assertRemoteSchemaVersion(observed);
      observed = await this.#reconcilePendingUpload(observed);
      if (!this.#session.hasOnlyMigrationChanges()) {
        return "unchanged";
      }
      if ((observed?.revision ?? null) !== this.#session.lastSyncedRemoteRevision) {
        if (await this.#confirmEquivalentRemoteMigration()) {
          return "unchanged";
        }
        await this.#session.recordConflict(toObservedRemoteVersion(observed));
        return "conflict";
      }
      return this.#pushInsideGate(false);
    });
  }

  async #saveCurrentInsideGate(): Promise<SyncActionResult> {
    return await this.#session.saveCurrent() ? "saved" : "unchanged";
  }

  async #pushInsideGate(overwrite: boolean): Promise<SyncActionResult> {
    const pending = await this.#session.ensurePendingUpload(
      this.#createUuid,
      () => this.#now().toISOString(),
    );
    const schemaVersion = this.#session.schemaVersion;
    const payload = this.#session.payloadForRemote;

    try {
      const result = overwrite
        ? await this.#remoteRepository.overwrite(payload, {
            nextRevision: pending.nextRemoteRevision,
            ...(schemaVersion === null
              ? {}
              : { schemaVersion }),
            updatedAt: pending.updatedAt,
          })
        : await this.#remoteRepository.push(payload, {
            expectedRevision: this.#session.lastSyncedRemoteRevision,
            nextRevision: pending.nextRemoteRevision,
            ...(schemaVersion === null
              ? {}
              : { schemaVersion }),
            updatedAt: pending.updatedAt,
          });

      await this.#session.confirmPendingUpload(toObservedRemoteVersion(result));
      return "uploaded";
    } catch (error) {
      if (error instanceof RemoteModuleConflictError) {
        if (
          this.#session.hasOnlyMigrationChanges()
          && await this.#confirmEquivalentRemoteMigration()
        ) {
          return "unchanged";
        }
        await this.#session.recordConflict({
          revision: error.actualRevision,
          updatedAt: error.actualUpdatedAt,
        });
        throw new SyncConflictPendingError(error.actualRevision);
      }
      throw error;
    }
  }

  async #reconcilePendingUpload(
    observed: RemoteRevisionSnapshot | null,
  ): Promise<RemoteRevisionSnapshot | null> {
    const pending = this.#session.pendingUpload;
    if (!pending) {
      return observed;
    }

    if (observed?.revision === pending.nextRemoteRevision) {
      await this.#session.confirmPendingUpload(toObservedRemoteVersion(observed));
      return observed;
    }

    if ((observed?.revision ?? null) !== this.#session.lastSyncedRemoteRevision) {
      if (this.#session.hasOnlyMigrationChanges()) {
        return observed;
      }
      await this.#session.recordConflict(toObservedRemoteVersion(observed));
      throw new SyncConflictPendingError(observed?.revision ?? null);
    }

    await this.#session.discardStalePendingUpload();
    return observed;
  }

  async #pullInsideGate(): Promise<SyncActionResult> {
    const remote = await this.#remoteRepository.pull();
    const prepared = prepareStoredModulePayload(
      this.#definition,
      remote?.data ?? this.#definition.createEmpty(),
      remote
        ? remote.schemaVersion ?? null
        : this.#definition.migration?.currentVersion ?? null,
      "remote",
    );
    const contentHash = await hashModulePayload(this.#definition, prepared.payload);
    await this.#session.replaceFromRemote(
      prepared,
      contentHash,
      toObservedRemoteVersion(remote),
    );
    this.#hooks.reload();
    return "reloaded";
  }

  #assertRemoteSchemaVersion(observed: RemoteRevisionSnapshot | null): void {
    const policy = this.#definition.migration;
    if (!policy || observed === null) {
      return;
    }
    const version = observed.schemaVersion ?? null;
    if (version === null) {
      throw new MissingModuleSchemaVersionError("remote");
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ModuleMigrationError(
        "Remote schemaVersion must be a positive safe integer.",
      );
    }
    if (version > policy.currentVersion) {
      throw new UnsupportedModuleSchemaVersionError(
        version,
        policy.currentVersion,
      );
    }
  }

  async #confirmEquivalentRemoteMigration(): Promise<boolean> {
    if (!this.#session.hasOnlyMigrationChanges()) {
      return false;
    }

    const remote = await this.#remoteRepository.pull();
    const prepared = prepareStoredModulePayload(
      this.#definition,
      remote?.data ?? this.#definition.createEmpty(),
      remote
        ? remote.schemaVersion ?? null
        : this.#definition.migration?.currentVersion ?? null,
      "remote",
    );
    // The cloud must already contain the current schema. If it is also old,
    // another device has not actually published the format upgrade yet.
    if (prepared.migrated) {
      return false;
    }
    const remoteHash = await hashModulePayload(this.#definition, prepared.payload);
    if (remoteHash !== this.#session.contentHash) {
      return false;
    }

    await this.#session.confirmEquivalentRemoteMigration(
      toObservedRemoteVersion(remote),
    );
    return true;
  }

  async #settleAndDispatch(reason: SettleReason): Promise<void> {
    this.#assertInitialized();
    const pendingEvent = await this.#hooks.settle(reason);
    if (pendingEvent !== null) {
      this.dispatch(pendingEvent);
    }
  }

  #assertInitialized(): void {
    if (!this.#session.initialized) {
      throw new SyncCoordinatorNotInitializedError();
    }
  }
}

function toObservedRemoteVersion(
  snapshot: Pick<
    RemoteRevisionSnapshot,
    "revision" | "updatedAt" | "schemaVersion"
  > | null,
): ObservedRemoteVersion {
  return {
    revision: snapshot?.revision ?? null,
    updatedAt: snapshot?.updatedAt ?? null,
    schemaVersion: snapshot?.schemaVersion ?? null,
  };
}
