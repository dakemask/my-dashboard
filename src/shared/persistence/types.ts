export interface PendingUpload {
  readonly localRevision: string;
  readonly contentHash: string;
  readonly nextRemoteRevision: string;
  readonly updatedAt: string;
}

export interface PersistedConflict {
  readonly observedRemoteRevision: string | null;
  readonly observedRemoteUpdatedAt: string | null;
  readonly detectedAt: string;
}

export interface PersistedMigration {
  /** Legacy migration state consumed and cleared by the next runtime startup. */
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migratedContentHash: string;
  readonly businessChanged: boolean;
}

/** The single record stored for one module. Business data is only `payload`. */
export interface ModuleLocalEnvelope<T> {
  readonly payload: T;
  /** Business format version for payload; null only for modules without migration policy. */
  readonly schemaVersion: number | null;
  readonly contentHash: string;
  readonly localRevision: string;
  readonly localSavedAt: string | null;
  readonly lastSyncedContentHash: string | null;
  readonly lastSyncedRemoteRevision: string | null;
  readonly lastSyncedRemoteUpdatedAt: string | null;
  readonly pendingUpload: PendingUpload | null;
  readonly conflict: PersistedConflict | null;
  /** Legacy field kept only so existing IndexedDB records can be normalized once. */
  readonly migration: PersistedMigration | null;
}

export type ModuleLocalEnvelopeInput<T> = ModuleLocalEnvelope<T>;

export function createLocalRevision(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Web Crypto randomUUID is required to create a local revision.");
  }
  return globalThis.crypto.randomUUID();
}

export function createModuleLocalEnvelope<T>(
  payload: T,
  contentHash: string,
  localRevision = createLocalRevision(),
  schemaVersion: number | null = null,
): ModuleLocalEnvelope<T> {
  return {
    payload,
    schemaVersion,
    contentHash,
    localRevision,
    localSavedAt: null,
    lastSyncedContentHash: null,
    lastSyncedRemoteRevision: null,
    lastSyncedRemoteUpdatedAt: null,
    pendingUpload: null,
    conflict: null,
    migration: null,
  };
}
