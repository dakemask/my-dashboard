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
  type PersistedMigration,
} from "../persistence";
import { hashContentKey } from "./contentHash";
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

interface ObservedRemoteVersion {
  readonly revision: string | null;
  readonly updatedAt: string | null;
  readonly schemaVersion?: number | null;
}

interface PreparedPayload<T> {
  readonly payload: T;
  readonly migrated: boolean;
  readonly fromVersion: number | null;
  readonly toVersion: number | null;
}

export class SyncCoordinator<T, E> {
  readonly #definition: ModuleDefinition<T, E>;
  readonly #localStore: ModuleLocalStore<T>;
  readonly #remoteRepository: RemoteModulePort<T>;
  readonly #operationGate: OperationGate;
  readonly #hooks: SyncCoordinatorHooks<T, E>;
  readonly #now: () => Date;
  readonly #createUuid: () => string;
  #history: StagingHistory<T, E> | null = null;
  #local: ModuleLocalEnvelope<T> | null = null;

  constructor(options: SyncCoordinatorOptions<T, E>) {
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

  get history(): StagingHistory<T, E> {
    this.#assertInitialized();
    return this.#history!;
  }

  getSnapshot(): SyncCoordinatorSnapshot {
    if (!this.#history || !this.#local) {
      return {
        initialized: false,
        sessionDirty: false,
        localChangedSinceSync: false,
        businessChangedSinceSync: false,
        migrationChangedSinceSync: false,
        localSavedAt: null,
        knownRemoteRevision: null,
        knownRemoteUpdatedAt: null,
        lastSyncedRemoteRevision: null,
        pendingUpload: null,
        conflict: null,
      };
    }

    const knownRemoteRevision = this.#local.conflict
      ? this.#local.conflict.observedRemoteRevision
      : this.#local.lastSyncedRemoteRevision;
    const knownRemoteUpdatedAt = this.#local.conflict
      ? this.#local.conflict.observedRemoteUpdatedAt
      : this.#local.lastSyncedRemoteUpdatedAt;
    const businessChangedSinceSync = this.#hasBusinessChanges();
    const migrationChangedSinceSync = this.#local.migration !== null;
    return {
      initialized: true,
      sessionDirty: this.#history.dirty,
      localChangedSinceSync: businessChangedSinceSync || migrationChangedSinceSync,
      businessChangedSinceSync,
      migrationChangedSinceSync,
      localSavedAt: this.#local.localSavedAt,
      knownRemoteRevision,
      knownRemoteUpdatedAt,
      lastSyncedRemoteRevision: this.#local.lastSyncedRemoteRevision,
      pendingUpload: structuredClone(this.#local.pendingUpload),
      conflict: structuredClone(this.#local.conflict),
    };
  }

  async initialize(): Promise<T> {
    if (this.#history) {
      return this.#history.current;
    }

    let local = await this.#localStore.load();
    if (local) {
      const prepared = this.#preparePayloadWithMigration(
        local.payload,
        local.schemaVersion,
        "local",
      );
      const contentHash = await this.#hashPayload(prepared.payload);
      if (!prepared.migrated && contentHash !== local.contentHash) {
        throw new LocalDataIntegrityError();
      }
      if (prepared.migrated) {
        const migration = this.#createPersistedMigration(
          prepared,
          contentHash,
          local.contentHash !== local.lastSyncedContentHash || local.conflict !== null,
        );
        const next = {
          ...local,
          payload: prepared.payload,
          schemaVersion: prepared.toVersion,
          contentHash,
          localRevision: createLocalRevision(),
          localSavedAt: this.#now().toISOString(),
          migration,
        };
        local = await this.#localStore.compareAndSwap(local.localRevision, next);
      } else {
        local = { ...local, payload: prepared.payload };
      }
    } else {
      local = await this.#operationGate.runCloud(async () => {
        const remote = await this.#remoteRepository.pull();
        const prepared = this.#preparePayloadWithMigration(
          remote?.data ?? this.#definition.createEmpty(),
          remote
            ? remote.schemaVersion ?? null
            : this.#definition.migration?.currentVersion ?? null,
          "remote",
        );
        const contentHash = await this.#hashPayload(prepared.payload);
        const initial = {
          ...createModuleLocalEnvelope(
            prepared.payload,
            contentHash,
            undefined,
            prepared.toVersion,
          ),
          localSavedAt: this.#now().toISOString(),
          lastSyncedContentHash: contentHash,
          lastSyncedRemoteRevision: remote?.revision ?? null,
          lastSyncedRemoteUpdatedAt: remote?.updatedAt ?? null,
          migration: prepared.migrated
            ? this.#createPersistedMigration(prepared, contentHash, false)
            : null,
        };
        return this.#localStore.initialize(initial);
      });
    }

    this.#local = local;
    this.#history = this.#createHistory(local.payload);
    this.#hooks.project(this.#history.current, "initialize");
    if (local.conflict) {
      this.#hooks.onConflict?.(structuredClone(local.conflict));
    }
    return this.#history.current;
  }

  #createHistory(payload: T): StagingHistory<T, E> {
    return new StagingHistory(payload, {
      contentKey: (payload) => this.#getContentKey(payload),
      policy: {
        capacity: this.#definition.history.capacity,
        apply: (payload, event) =>
          this.#prepareCurrentPayload(this.#definition.history.apply(payload, event)),
        invert: (event, before, after) => this.#definition.history.invert(
          event,
          before,
          after,
        ),
      },
    });
  }

  dispatch(event: E): T {
    this.#assertInitialized();
    return this.#history!.dispatch(event);
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

      if (this.#local!.conflict) {
        throw new SyncConflictPendingError(this.#local!.conflict.observedRemoteRevision);
      }

      if ((observed?.revision ?? null) !== this.#local!.lastSyncedRemoteRevision) {
        if (this.#hasLocalChanges()) {
          if (await this.#confirmEquivalentRemoteMigration()) {
            return "unchanged";
          }
          await this.#recordConflict(toObservedRemoteVersion(observed));
          throw new SyncConflictPendingError(observed?.revision ?? null);
        }
        return this.#pullInsideGate();
      }

      await this.#backfillSyncedRemoteUpdatedAt(observed);

      if (
        this.#local!.contentHash === this.#local!.lastSyncedContentHash
        && this.#local!.migration === null
      ) {
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
      this.#assertRemoteSchemaVersion(remote);
      try {
        remote = await this.#reconcilePendingUpload(remote);
      } catch (error) {
        if (error instanceof SyncConflictPendingError) {
          return "conflict";
        }
        throw error;
      }

      if ((remote?.revision ?? null) === this.#local!.lastSyncedRemoteRevision) {
        await this.#backfillSyncedRemoteUpdatedAt(remote);
        return "unchanged";
      }

      await this.#settleAndDispatch("pull");
      if (this.#hasLocalChanges()) {
        if (await this.#confirmEquivalentRemoteMigration()) {
          return "unchanged";
        }
        await this.#recordConflict(toObservedRemoteVersion(remote));
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
    if (this.#local!.pendingUpload?.nextRemoteRevision === remoteRevision) {
      return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
        await this.#confirmPendingUpload(toObservedRemoteVersion(observed));
        return "uploaded";
      });
    }

    if (this.#local!.conflict) {
      const remoteVersion = toObservedRemoteVersion(observed);
      const revisionChanged = this.#local!.conflict.observedRemoteRevision !== remoteVersion.revision;
      if (
        revisionChanged
        || (
          remoteVersion.updatedAt !== null
          && this.#local!.conflict.observedRemoteUpdatedAt !== remoteVersion.updatedAt
        )
      ) {
        if (revisionChanged) await this.#settleAndDispatch("remote-change");
        return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
          await this.#recordConflict(remoteVersion);
          return "conflict";
        });
      }
      return "conflict";
    }

    if (remoteRevision === this.#local!.lastSyncedRemoteRevision) {
      if (this.#hasOnlyMigrationChanges()) {
        return this.publishMigrationIfSafe();
      }
      if (this.#needsSyncedRemoteTimestampBackfill(observed)) {
        return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
          await this.#backfillSyncedRemoteUpdatedAt(observed);
          return "unchanged";
        });
      }
      return "unchanged";
    }

    await this.#settleAndDispatch("remote-change");
    if (this.#hasLocalChanges()) {
      if (this.#hasOnlyMigrationChanges()) {
        return this.#operationGate.runCloud(async (): Promise<SyncActionResult> => {
          if (await this.#confirmEquivalentRemoteMigration()) {
            return "unchanged";
          }
          await this.#recordConflict(toObservedRemoteVersion(observed));
          return "conflict";
        });
      }
      return this.#operationGate.runLocal<SyncActionResult>(async (): Promise<SyncActionResult> => {
        await this.#recordConflict(toObservedRemoteVersion(observed));
        return "conflict";
      });
    }

    return this.#operationGate.runCloud(() => this.#pullInsideGate());
  }

  close(): void {
    this.#localStore.close();
  }

  /**
   * Best-effort automatic publication for a pure local schema migration. It
   * never settles UI state and therefore stops as soon as business edits exist.
   */
  async publishMigrationIfSafe(): Promise<SyncActionResult> {
    this.#assertInitialized();
    if (!this.#hasOnlyMigrationChanges()) {
      return "unchanged";
    }

    return this.#operationGate.runCloud(async () => {
      let observed = await this.#remoteRepository.readRevision();
      this.#assertRemoteSchemaVersion(observed);
      observed = await this.#reconcilePendingUpload(observed);
      if (!this.#hasOnlyMigrationChanges()) {
        return "unchanged";
      }
      if ((observed?.revision ?? null) !== this.#local!.lastSyncedRemoteRevision) {
        if (await this.#confirmEquivalentRemoteMigration()) {
          return "unchanged";
        }
        await this.#recordConflict(toObservedRemoteVersion(observed));
        return "conflict";
      }
      return this.#pushInsideGate(false);
    });
  }

  async #saveCurrentInsideGate(): Promise<SyncActionResult> {
    if (!this.history.dirty) {
      return "unchanged";
    }

    const payload = this.history.current;
    const contentHash = await this.#hashPayload(payload);
    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      payload,
      contentHash,
      localRevision: nextLocalRevision,
      localSavedAt: this.#now().toISOString(),
      migration: local.migration
        ? {
            ...local.migration,
            businessChanged:
              local.migration.businessChanged
              || contentHash !== local.migration.migratedContentHash,
          }
        : null,
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
        ? await this.#remoteRepository.overwrite(structuredClone(this.#local!.payload), {
            nextRevision: pending.nextRemoteRevision,
            ...(this.#local!.schemaVersion === null
              ? {}
              : { schemaVersion: this.#local!.schemaVersion }),
            updatedAt: pending.updatedAt,
          })
        : await this.#remoteRepository.push(structuredClone(this.#local!.payload), {
            expectedRevision: this.#local!.lastSyncedRemoteRevision,
            nextRevision: pending.nextRemoteRevision,
            ...(this.#local!.schemaVersion === null
              ? {}
              : { schemaVersion: this.#local!.schemaVersion }),
            updatedAt: pending.updatedAt,
          });

      await this.#confirmPendingUpload(toObservedRemoteVersion(result));
      return "uploaded";
    } catch (error) {
      if (error instanceof RemoteModuleConflictError) {
        if (
          this.#hasOnlyMigrationChanges()
          && await this.#confirmEquivalentRemoteMigration()
        ) {
          return "unchanged";
        }
        await this.#recordConflict({
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
    const pending = this.#local!.pendingUpload;
    if (!pending) {
      return observed;
    }

    if (observed?.revision === pending.nextRemoteRevision) {
      await this.#confirmPendingUpload(toObservedRemoteVersion(observed));
      return observed;
    }

    if ((observed?.revision ?? null) !== this.#local!.lastSyncedRemoteRevision) {
      if (this.#hasOnlyMigrationChanges()) {
        return observed;
      }
      await this.#recordConflict(toObservedRemoteVersion(observed));
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

  async #confirmPendingUpload(remote: ObservedRemoteVersion): Promise<void> {
    const pending = this.#local!.pendingUpload;
    if (!pending) {
      return;
    }
    const retainMigration = this.#local!.migration !== null
      && (remote.schemaVersion ?? null) !== this.#local!.schemaVersion;

    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      lastSyncedContentHash: pending.contentHash,
      lastSyncedRemoteRevision: remote.revision,
      lastSyncedRemoteUpdatedAt: remote.updatedAt ?? pending.updatedAt,
      pendingUpload: null,
      conflict: null,
      migration: retainMigration ? local.migration : null,
    }));
  }

  async #pullInsideGate(): Promise<SyncActionResult> {
    const remote = await this.#remoteRepository.pull();
    const prepared = this.#preparePayloadWithMigration(
      remote?.data ?? this.#definition.createEmpty(),
      remote
        ? remote.schemaVersion ?? null
        : this.#definition.migration?.currentVersion ?? null,
      "remote",
    );
    const contentHash = await this.#hashPayload(prepared.payload);
    await this.#writeLocal((_local, nextLocalRevision) => ({
      payload: prepared.payload,
      schemaVersion: prepared.toVersion,
      contentHash,
      localRevision: nextLocalRevision,
      localSavedAt: this.#now().toISOString(),
      lastSyncedContentHash: contentHash,
      lastSyncedRemoteRevision: remote?.revision ?? null,
      lastSyncedRemoteUpdatedAt: remote?.updatedAt ?? null,
      pendingUpload: null,
      conflict: null,
      migration: prepared.migrated
        ? this.#createPersistedMigration(prepared, contentHash, false)
        : null,
    }));
    this.#history = this.#createHistory(prepared.payload);
    this.#hooks.reload();
    return "reloaded";
  }

  async #recordConflict(remote: ObservedRemoteVersion): Promise<PersistedConflict> {
    const existing = this.#local!.conflict;
    if (existing?.observedRemoteRevision === remote.revision) {
      const observedRemoteUpdatedAt = remote.updatedAt ?? existing.observedRemoteUpdatedAt;
      if (existing.observedRemoteUpdatedAt === observedRemoteUpdatedAt) {
        return existing;
      }

      const updatedConflict = { ...existing, observedRemoteUpdatedAt };
      await this.#writeLocal((local, nextLocalRevision) => ({
        ...local,
        localRevision: nextLocalRevision,
        conflict: updatedConflict,
      }));
      this.#hooks.onConflict?.(structuredClone(updatedConflict));
      return updatedConflict;
    }

    const conflict: PersistedConflict = {
      observedRemoteRevision: remote.revision,
      observedRemoteUpdatedAt: remote.updatedAt,
      detectedAt: this.#now().toISOString(),
    };
    const payload = this.history.current;
    const contentHash = await this.#hashPayload(payload);
    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      payload,
      contentHash,
      localRevision: nextLocalRevision,
      localSavedAt: this.#now().toISOString(),
      conflict,
    }));
    this.history.updateBaseline(payload);
    this.#hooks.onConflict?.(structuredClone(conflict));
    return conflict;
  }

  #needsSyncedRemoteTimestampBackfill(observed: RemoteRevisionSnapshot | null): boolean {
    return observed !== null
      && observed.revision === this.#local!.lastSyncedRemoteRevision
      && observed.updatedAt !== this.#local!.lastSyncedRemoteUpdatedAt;
  }

  async #backfillSyncedRemoteUpdatedAt(
    observed: RemoteRevisionSnapshot | null,
  ): Promise<void> {
    if (!this.#needsSyncedRemoteTimestampBackfill(observed)) {
      return;
    }

    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      lastSyncedRemoteUpdatedAt: observed!.updatedAt,
    }));
  }

  async #writeLocal(
    createNext: (current: ModuleLocalEnvelope<T>, nextLocalRevision: string) => ModuleLocalEnvelope<T>,
  ): Promise<void> {
    const current = this.#local!;
    const next = createNext(current, createLocalRevision());
    this.#local = await this.#localStore.compareAndSwap(current.localRevision, next);
  }

  #hasLocalChanges(): boolean {
    return this.#hasBusinessChanges() || this.#local!.migration !== null;
  }

  #hasBusinessChanges(): boolean {
    if (this.history.dirty) {
      return true;
    }
    const migration = this.#local!.migration;
    if (migration) {
      return migration.businessChanged
        || this.#local!.contentHash !== migration.migratedContentHash;
    }
    return this.#local!.contentHash !== this.#local!.lastSyncedContentHash;
  }

  #hasOnlyMigrationChanges(): boolean {
    return this.#local!.migration !== null
      && !this.#hasBusinessChanges()
      && this.#local!.conflict === null;
  }

  #prepareCurrentPayload(value: unknown): T {
    const payload = structuredClone(this.#definition.validate(value));
    this.#definition.validate(structuredClone(payload));
    this.#getContentKey(payload);
    return payload;
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

  #preparePayloadWithMigration(
    value: unknown,
    sourceVersion: number | null,
    source: "local" | "remote",
  ): PreparedPayload<T> {
    const policy = this.#definition.migration;
    if (!policy) {
      return {
        payload: this.#prepareCurrentPayload(value),
        migrated: false,
        fromVersion: null,
        toVersion: null,
      };
    }

    let current = structuredClone(value);
    if (sourceVersion === null) {
      throw new MissingModuleSchemaVersionError(source);
    }
    if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
      throw new ModuleMigrationError(
        "Stored schemaVersion must be a positive safe integer.",
      );
    }
    const fromVersion = sourceVersion;
    if (fromVersion > policy.currentVersion) {
      throw new UnsupportedModuleSchemaVersionError(
        fromVersion,
        policy.currentVersion,
      );
    }

    let version = fromVersion;
    while (version < policy.currentVersion) {
      const migrated = policy.migrate(structuredClone(current), version);
      current = structuredClone(migrated);
      version += 1;
    }

    return {
      payload: this.#prepareCurrentPayload(current),
      migrated: fromVersion !== policy.currentVersion,
      fromVersion,
      toVersion: policy.currentVersion,
    };
  }

  #createPersistedMigration(
    prepared: PreparedPayload<T>,
    migratedContentHash: string,
    businessChanged: boolean,
  ): PersistedMigration {
    if (
      !prepared.migrated
      || prepared.fromVersion === null
      || prepared.toVersion === null
    ) {
      throw new ModuleMigrationError("Cannot persist migration metadata for an unchanged payload.");
    }
    return {
      fromVersion: prepared.fromVersion,
      toVersion: prepared.toVersion,
      migratedContentHash,
      businessChanged,
    };
  }

  async #confirmEquivalentRemoteMigration(): Promise<boolean> {
    if (!this.#hasOnlyMigrationChanges()) {
      return false;
    }

    const remote = await this.#remoteRepository.pull();
    const prepared = this.#preparePayloadWithMigration(
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
    const remoteHash = await this.#hashPayload(prepared.payload);
    if (remoteHash !== this.#local!.contentHash) {
      return false;
    }

    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      lastSyncedContentHash: local.contentHash,
      lastSyncedRemoteRevision: remote?.revision ?? null,
      lastSyncedRemoteUpdatedAt: remote?.updatedAt ?? null,
      pendingUpload: null,
      conflict: null,
      migration: null,
    }));
    return true;
  }

  #getContentKey(payload: T): string {
    const key = this.#definition.contentKey(structuredClone(payload));
    if (typeof key !== "string") {
      throw new TypeError("ModuleDefinition.contentKey must return a string.");
    }
    return key;
  }

  #hashPayload(payload: T): Promise<string> {
    return hashContentKey(this.#getContentKey(payload));
  }

  async #settleAndDispatch(reason: SettleReason): Promise<void> {
    this.#assertInitialized();
    const pendingEvent = await this.#hooks.settle(reason);
    if (pendingEvent !== null) {
      this.dispatch(pendingEvent);
    }
  }

  #assertInitialized(): void {
    if (!this.#history || !this.#local) {
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
