export interface PendingUpload {
  readonly localRevision: string;
  readonly contentHash: string;
  readonly nextRemoteRevision: string;
  readonly updatedAt: string;
}

export interface PersistedConflict {
  readonly observedRemoteRevision: string | null;
  readonly detectedAt: string;
}

/** The single record stored for one module. Business data is only `payload`. */
export interface ModuleLocalEnvelope<T> {
  readonly payload: T;
  readonly contentHash: string;
  readonly localRevision: string;
  readonly lastSyncedContentHash: string | null;
  readonly lastSyncedRemoteRevision: string | null;
  readonly pendingUpload: PendingUpload | null;
  readonly conflict: PersistedConflict | null;
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
): ModuleLocalEnvelope<T> {
  return {
    payload,
    contentHash,
    localRevision,
    lastSyncedContentHash: null,
    lastSyncedRemoteRevision: null,
    pendingUpload: null,
    conflict: null,
  };
}
