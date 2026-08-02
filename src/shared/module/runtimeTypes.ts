import type { AuthService } from "../auth";
import type { GitHubFetch } from "../github";
import type { PersistedConflict } from "../persistence";
import type { DashboardProfileStore } from "../profiles";
import type {
  ConflictResolution,
  ModuleDefinition,
  ProjectionReason,
  SettleReason,
  SyncActionResult,
  SyncCoordinatorSnapshot,
} from "../sync";

export type ModuleRuntimeState =
  | "starting"
  | "ready"
  | "disposing"
  | "disposed";

export interface ModuleRuntimeHooks<TPayload, TEvent> {
  /** Ends or cancels live UI interaction before a shared action reads the payload. */
  settle(reason: SettleReason): TEvent | null | Promise<TEvent | null>;
  /** Rebuilds the module UI after initialization, undo, or redo. */
  project(payload: TPayload, reason: ProjectionReason): void;
  onConflict?(conflict: PersistedConflict): void;
  /** Observes runtime status without becoming part of command execution. */
  onSnapshotChange?(snapshot: SyncCoordinatorSnapshot): void;
}

export interface StartModuleRuntimeOptions<TPayload, TEvent> {
  readonly definition: ModuleDefinition<TPayload, TEvent>;
  readonly appRoot: HTMLElement;
  readonly hooks: ModuleRuntimeHooks<TPayload, TEvent>;
  readonly cloudStatusLabel?: string;
}

/** Platform/test injection. Business modules normally omit this entire argument. */
export interface ModuleRuntimeEnvironment {
  readonly authService?: AuthService;
  readonly profileStore?: DashboardProfileStore;
  readonly fetch?: GitHubFetch;
  readonly indexedDB?: IDBFactory;
  readonly lockManager?: LockManager | null;
  readonly document?: Document;
  readonly window?: Window;
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
  readonly autoStartPolling?: boolean;
  readonly reload?: () => void;
  readonly onAuthenticationRequired?: () => void;
}

export interface ModuleRuntime<TPayload, TEvent> {
  readonly mode: "local" | "account";
  readonly state: ModuleRuntimeState;
  readonly current: TPayload;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  dispatch(event: TEvent): TPayload;
  undo(): Promise<TPayload>;
  redo(): Promise<TPayload>;
  save(): Promise<SyncActionResult>;
  upload(): Promise<SyncActionResult>;
  pull(): Promise<SyncActionResult>;
  resolveConflict(strategy: ConflictResolution): Promise<SyncActionResult>;
  pollNow(): Promise<void>;
  getSnapshot(): SyncCoordinatorSnapshot;
  dispose(): Promise<void>;
}

export type ModuleRuntimeStartResult<TPayload, TEvent> =
  | {
      readonly status: "ready";
      readonly initialPayload: TPayload;
      readonly runtime: ModuleRuntime<TPayload, TEvent>;
    }
  | { readonly status: "blocked" }
  | { readonly status: "unsupported" }
  | { readonly status: "authentication-required" };

export class ModuleRuntimeUnavailableError extends Error {
  constructor(readonly runtimeState: ModuleRuntimeState) {
    super(`The module runtime is not ready (state: ${runtimeState}).`);
    this.name = "ModuleRuntimeUnavailableError";
  }
}

export class ModuleRuntimeBusyError extends Error {
  constructor() {
    super("The module runtime is already processing another command.");
    this.name = "ModuleRuntimeBusyError";
  }
}
