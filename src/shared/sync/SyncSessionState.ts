import { StagingHistory } from "../history";
import {
  ModuleLocalStore,
  createLocalRevision,
  createModuleLocalEnvelope,
  type ModuleLocalEnvelope,
  type PendingUpload,
  type PersistedConflict,
  type PersistedMigration,
} from "../persistence";
import {
  getModuleContentKey,
  hashModulePayload,
  prepareCurrentModulePayload,
  type PreparedModulePayload,
} from "./modulePayload";
import {
  ModuleMigrationError,
  SyncCoordinatorNotInitializedError,
  type ModuleDefinition,
  type SyncCoordinatorSnapshot,
} from "./types";

export interface ObservedRemoteVersion {
  readonly revision: string | null;
  readonly updatedAt: string | null;
  readonly schemaVersion?: number | null;
}

interface SyncSessionStateOptions<TPayload, TEvent> {
  readonly definition: ModuleDefinition<TPayload, TEvent>;
  readonly localStore: ModuleLocalStore<TPayload>;
  readonly now: () => Date;
  readonly onConflict?: (conflict: PersistedConflict) => void;
}

/**
 * Owns the complete local synchronization session. Remote I/O and four-way
 * decisions remain in SyncCoordinator; this class keeps every envelope, CAS,
 * history, pending, conflict and snapshot transition in one place.
 */
export class SyncSessionState<TPayload, TEvent> {
  readonly #definition: ModuleDefinition<TPayload, TEvent>;
  readonly #localStore: ModuleLocalStore<TPayload>;
  readonly #now: () => Date;
  readonly #onConflict?: (conflict: PersistedConflict) => void;
  #history: StagingHistory<TPayload, TEvent> | null = null;
  #local: ModuleLocalEnvelope<TPayload> | null = null;

  constructor(options: SyncSessionStateOptions<TPayload, TEvent>) {
    this.#definition = options.definition;
    this.#localStore = options.localStore;
    this.#now = options.now;
    this.#onConflict = options.onConflict;
  }

  get initialized(): boolean {
    return this.#history !== null && this.#local !== null;
  }

  get history(): StagingHistory<TPayload, TEvent> {
    this.#assertInitialized();
    return this.#history!;
  }

  get contentHash(): string {
    this.#assertInitialized();
    return this.#local!.contentHash;
  }

  get schemaVersion(): number | null {
    this.#assertInitialized();
    return this.#local!.schemaVersion;
  }

  get lastSyncedRemoteRevision(): string | null {
    this.#assertInitialized();
    return this.#local!.lastSyncedRemoteRevision;
  }

  get pendingUpload(): PendingUpload | null {
    this.#assertInitialized();
    return structuredClone(this.#local!.pendingUpload);
  }

  get conflict(): PersistedConflict | null {
    this.#assertInitialized();
    return structuredClone(this.#local!.conflict);
  }

  get payloadForRemote(): TPayload {
    this.#assertInitialized();
    return structuredClone(this.#local!.payload);
  }

  load(): Promise<ModuleLocalEnvelope<TPayload> | null> {
    return this.#localStore.load();
  }

  /** Activates an existing envelope, atomically persisting migration first. */
  async openLoaded(
    local: ModuleLocalEnvelope<TPayload>,
    prepared: PreparedModulePayload<TPayload>,
    contentHash: string,
  ): Promise<void> {
    let activated: ModuleLocalEnvelope<TPayload>;
    if (prepared.migrated) {
      const migration = this.#createPersistedMigration(
        prepared,
        contentHash,
        local.contentHash !== local.lastSyncedContentHash || local.conflict !== null,
      );
      activated = await this.#localStore.compareAndSwap(local.localRevision, {
        ...local,
        payload: prepared.payload,
        schemaVersion: prepared.toVersion,
        contentHash,
        localRevision: createLocalRevision(),
        localSavedAt: this.#now().toISOString(),
        migration,
      });
    } else {
      activated = { ...local, payload: structuredClone(prepared.payload) };
    }
    this.#activate(activated);
  }

  /** Creates and activates the first envelope for a profile/module pair. */
  async initializeNew(
    prepared: PreparedModulePayload<TPayload>,
    contentHash: string,
    remote: ObservedRemoteVersion,
  ): Promise<void> {
    const initial = {
      ...createModuleLocalEnvelope(
        prepared.payload,
        contentHash,
        undefined,
        prepared.toVersion,
      ),
      localSavedAt: this.#now().toISOString(),
      lastSyncedContentHash: contentHash,
      lastSyncedRemoteRevision: remote.revision,
      lastSyncedRemoteUpdatedAt: remote.updatedAt,
      migration: prepared.migrated
        ? this.#createPersistedMigration(prepared, contentHash, false)
        : null,
    };
    this.#activate(await this.#localStore.initialize(initial));
  }

  notifyPersistedConflict(): void {
    const conflict = this.conflict;
    if (conflict) {
      this.#onConflict?.(conflict);
    }
  }

  dispatch(event: TEvent): TPayload {
    return this.history.dispatch(event);
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
    const businessChangedSinceSync = this.hasBusinessChanges();
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

  hasLocalChanges(): boolean {
    this.#assertInitialized();
    return this.hasBusinessChanges() || this.#local!.migration !== null;
  }

  hasBusinessChanges(): boolean {
    this.#assertInitialized();
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

  hasOnlyMigrationChanges(): boolean {
    this.#assertInitialized();
    return this.#local!.migration !== null
      && !this.hasBusinessChanges()
      && this.#local!.conflict === null;
  }

  isContentSynced(): boolean {
    this.#assertInitialized();
    return this.#local!.contentHash === this.#local!.lastSyncedContentHash
      && this.#local!.migration === null;
  }

  async saveCurrent(): Promise<boolean> {
    if (!this.history.dirty) {
      return false;
    }

    const payload = this.history.current;
    const contentHash = await hashModulePayload(this.#definition, payload);
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
    return true;
  }

  async ensurePendingUpload(
    createNextRemoteRevision: () => string,
    createUpdatedAt: () => string,
  ): Promise<PendingUpload> {
    const existing = this.#local!.pendingUpload;
    if (existing?.contentHash === this.#local!.contentHash) {
      return structuredClone(existing);
    }

    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      pendingUpload: {
        localRevision: nextLocalRevision,
        contentHash: local.contentHash,
        nextRemoteRevision: createNextRemoteRevision(),
        updatedAt: createUpdatedAt(),
      },
    }));
    return structuredClone(this.#local!.pendingUpload!);
  }

  async discardStalePendingUpload(): Promise<void> {
    const pending = this.#local!.pendingUpload;
    if (!pending || pending.contentHash === this.#local!.contentHash) {
      return;
    }
    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      pendingUpload: null,
    }));
  }

  async confirmPendingUpload(remote: ObservedRemoteVersion): Promise<void> {
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

  async recordConflict(remote: ObservedRemoteVersion): Promise<PersistedConflict> {
    const existing = this.#local!.conflict;
    if (existing?.observedRemoteRevision === remote.revision) {
      const observedRemoteUpdatedAt = remote.updatedAt ?? existing.observedRemoteUpdatedAt;
      if (existing.observedRemoteUpdatedAt === observedRemoteUpdatedAt) {
        return structuredClone(existing);
      }

      const updatedConflict = { ...existing, observedRemoteUpdatedAt };
      await this.#writeLocal((local, nextLocalRevision) => ({
        ...local,
        localRevision: nextLocalRevision,
        conflict: updatedConflict,
      }));
      this.#onConflict?.(structuredClone(updatedConflict));
      return structuredClone(updatedConflict);
    }

    const conflict: PersistedConflict = {
      observedRemoteRevision: remote.revision,
      observedRemoteUpdatedAt: remote.updatedAt,
      detectedAt: this.#now().toISOString(),
    };
    const payload = this.history.current;
    const contentHash = await hashModulePayload(this.#definition, payload);
    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      payload,
      contentHash,
      localRevision: nextLocalRevision,
      localSavedAt: this.#now().toISOString(),
      conflict,
    }));
    this.history.updateBaseline(payload);
    this.#onConflict?.(structuredClone(conflict));
    return structuredClone(conflict);
  }

  needsSyncedRemoteTimestampBackfill(
    observed: ObservedRemoteVersion | null,
  ): boolean {
    this.#assertInitialized();
    return observed !== null
      && observed.revision === this.#local!.lastSyncedRemoteRevision
      && observed.updatedAt !== this.#local!.lastSyncedRemoteUpdatedAt;
  }

  async backfillSyncedRemoteUpdatedAt(
    observed: ObservedRemoteVersion | null,
  ): Promise<void> {
    if (!this.needsSyncedRemoteTimestampBackfill(observed)) {
      return;
    }
    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      lastSyncedRemoteUpdatedAt: observed!.updatedAt,
    }));
  }

  async replaceFromRemote(
    prepared: PreparedModulePayload<TPayload>,
    contentHash: string,
    remote: ObservedRemoteVersion,
  ): Promise<void> {
    await this.#writeLocal((_local, nextLocalRevision) => ({
      payload: prepared.payload,
      schemaVersion: prepared.toVersion,
      contentHash,
      localRevision: nextLocalRevision,
      localSavedAt: this.#now().toISOString(),
      lastSyncedContentHash: contentHash,
      lastSyncedRemoteRevision: remote.revision,
      lastSyncedRemoteUpdatedAt: remote.updatedAt,
      pendingUpload: null,
      conflict: null,
      migration: prepared.migrated
        ? this.#createPersistedMigration(prepared, contentHash, false)
        : null,
    }));
    this.#history = this.#createHistory(prepared.payload);
  }

  async confirmEquivalentRemoteMigration(
    remote: ObservedRemoteVersion,
  ): Promise<void> {
    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      lastSyncedContentHash: local.contentHash,
      lastSyncedRemoteRevision: remote.revision,
      lastSyncedRemoteUpdatedAt: remote.updatedAt,
      pendingUpload: null,
      conflict: null,
      migration: null,
    }));
  }

  close(): void {
    this.#localStore.close();
  }

  #activate(local: ModuleLocalEnvelope<TPayload>): void {
    this.#local = structuredClone(local);
    this.#history = this.#createHistory(this.#local.payload);
  }

  #createHistory(payload: TPayload): StagingHistory<TPayload, TEvent> {
    return new StagingHistory(payload, {
      contentKey: (current) => getModuleContentKey(this.#definition, current),
      policy: {
        capacity: this.#definition.history.capacity,
        apply: (current, event) => prepareCurrentModulePayload(
          this.#definition,
          this.#definition.history.apply(current, event),
        ),
        invert: (event, before, after) => this.#definition.history.invert(
          event,
          before,
          after,
        ),
      },
    });
  }

  #createPersistedMigration(
    prepared: PreparedModulePayload<TPayload>,
    migratedContentHash: string,
    businessChanged: boolean,
  ): PersistedMigration {
    if (
      !prepared.migrated
      || prepared.fromVersion === null
      || prepared.toVersion === null
    ) {
      throw new ModuleMigrationError(
        "Cannot persist migration metadata for an unchanged payload.",
      );
    }
    return {
      fromVersion: prepared.fromVersion,
      toVersion: prepared.toVersion,
      migratedContentHash,
      businessChanged,
    };
  }

  async #writeLocal(
    createNext: (
      current: ModuleLocalEnvelope<TPayload>,
      nextLocalRevision: string,
    ) => ModuleLocalEnvelope<TPayload>,
  ): Promise<void> {
    this.#assertInitialized();
    const current = this.#local!;
    const next = createNext(current, createLocalRevision());
    this.#local = await this.#localStore.compareAndSwap(
      current.localRevision,
      next,
    );
  }

  #assertInitialized(): void {
    if (!this.#history || !this.#local) {
      throw new SyncCoordinatorNotInitializedError();
    }
  }
}
