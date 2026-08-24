import { StagingHistory } from "../history";
import {
  ModuleLocalStore,
  createLocalRevision,
  createModuleLocalEnvelope,
  type ModuleLocalEnvelope,
  type PendingUpload,
  type PersistedConflict,
} from "../persistence";
import {
  getModuleContentKey,
  hashModulePayload,
  prepareCurrentModulePayload,
  type PreparedModulePayload,
} from "./modulePayload";
import {
  SyncCoordinatorNotInitializedError,
  type ModuleDefinition,
  type SyncCoordinatorSnapshot,
} from "./types";

export interface ObservedRemoteVersion {
  readonly revision: string | null;
  readonly updatedAt: string | null;
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
    const legacyMigration = local.migration;
    if (prepared.migrated || legacyMigration !== null) {
      const businessChanged = legacyMigration
        ? legacyMigration.businessChanged
          || local.contentHash !== legacyMigration.migratedContentHash
        : local.contentHash !== local.lastSyncedContentHash;
      const nextLocalRevision = createLocalRevision();
      const pendingUpload = legacyMigration && !businessChanged
        ? null
        : prepared.migrated
            && local.pendingUpload?.contentHash === local.contentHash
          ? {
              ...local.pendingUpload,
              localRevision: nextLocalRevision,
              contentHash,
            }
          : local.pendingUpload;
      activated = await this.#localStore.compareAndSwap(local.localRevision, {
        ...local,
        payload: prepared.payload,
        schemaVersion: prepared.toVersion,
        contentHash,
        localRevision: nextLocalRevision,
        lastSyncedContentHash: businessChanged ? null : contentHash,
        pendingUpload,
        migration: null,
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
    return {
      initialized: true,
      sessionDirty: this.#history.dirty,
      localChangedSinceSync: businessChangedSinceSync,
      businessChangedSinceSync,
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
    return this.hasBusinessChanges();
  }

  hasBusinessChanges(): boolean {
    this.#assertInitialized();
    if (this.history.dirty) {
      return true;
    }
    return this.#local!.contentHash !== this.#local!.lastSyncedContentHash;
  }

  isContentSynced(): boolean {
    this.#assertInitialized();
    return this.#local!.contentHash === this.#local!.lastSyncedContentHash;
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

    await this.#writeLocal((local, nextLocalRevision) => ({
      ...local,
      localRevision: nextLocalRevision,
      lastSyncedContentHash: pending.contentHash,
      lastSyncedRemoteRevision: remote.revision,
      lastSyncedRemoteUpdatedAt: remote.updatedAt ?? pending.updatedAt,
      pendingUpload: null,
      conflict: null,
    }));
  }

  async recordConflict(remote: ObservedRemoteVersion): Promise<PersistedConflict> {
    const existing = this.#local!.conflict;
    if (existing?.observedRemoteRevision === remote.revision) {
      return structuredClone(existing);
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
      migration: null,
    }));
    this.#history = this.#createHistory(prepared.payload);
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
