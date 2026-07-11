import type {
  RemoteModuleCodec,
  RemoteModuleOverwriteOptions,
  RemoteModulePushOptions,
  RemoteModulePushResult,
  RemoteModuleSnapshot,
  RemoteRevisionSnapshot,
} from "../github";
import type { PersistedConflict, PendingUpload } from "../persistence";
import type { ModuleHistoryPolicy } from "../history";

export interface ModuleDefinition<TPayload, TEvent>
  extends RemoteModuleCodec<TPayload> {
  createEmpty(): TPayload;
  /** Deterministically represents all semantic payload content. */
  contentKey(payload: TPayload): string;
  /** Defines the module-owned, page-lifetime event history. */
  readonly history: ModuleHistoryPolicy<TPayload, TEvent>;
}

export interface RemoteModulePort<T> {
  readonly moduleId: string;
  readRevision(signal?: AbortSignal): Promise<RemoteRevisionSnapshot | null>;
  pull(): Promise<RemoteModuleSnapshot<T> | null>;
  push(data: T, options: RemoteModulePushOptions): Promise<RemoteModulePushResult>;
  overwrite(data: T, options: RemoteModuleOverwriteOptions): Promise<RemoteModulePushResult>;
}

export type SettleReason =
  | "local-save"
  | "upload"
  | "pull"
  | "remote-change"
  | "undo"
  | "redo";
export type ProjectionReason = "initialize" | "undo" | "redo";
export type ConflictResolution = "local-wins" | "cloud-wins";

export interface SyncCoordinatorHooks<TPayload, TEvent> {
  settle(reason: SettleReason): TEvent | null | Promise<TEvent | null>;
  project(payload: TPayload, reason: ProjectionReason): void;
  reload(): void;
  onConflict?(conflict: PersistedConflict): void;
}

export interface SyncCoordinatorSnapshot {
  initialized: boolean;
  sessionDirty: boolean;
  localChangedSinceSync: boolean;
  lastSyncedRemoteRevision: string | null;
  pendingUpload: PendingUpload | null;
  conflict: PersistedConflict | null;
}

export type SyncActionResult = "unchanged" | "saved" | "uploaded" | "conflict" | "reloaded" | "busy";

export class SyncCoordinatorNotInitializedError extends Error {
  constructor() {
    super("The module sync coordinator has not been initialized.");
    this.name = "SyncCoordinatorNotInitializedError";
  }
}

export class SyncConflictPendingError extends Error {
  constructor(readonly remoteRevision: string | null) {
    super("A synchronization conflict must be resolved before this operation can continue.");
    this.name = "SyncConflictPendingError";
  }
}

export class LocalDataIntegrityError extends Error {
  constructor() {
    super("The IndexedDB payload does not match its stored content hash.");
    this.name = "LocalDataIntegrityError";
  }
}
