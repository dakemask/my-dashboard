import { ModuleEditorLease, OperationGate } from "../concurrency";
import type { RemoteRevisionSnapshot } from "../github";
import {
  SyncConflictPendingError,
  type ConflictResolution,
  type RevisionPoller,
  type SyncActionResult,
  type SyncCoordinator,
  type SyncCoordinatorSnapshot,
} from "../sync";
import {
  ModuleRuntimeBusyError,
  ModuleRuntimeUnavailableError,
  type ModuleRuntime,
  type ModuleRuntimeState,
} from "./runtimeTypes";

export class DefaultModuleRuntime<TPayload, TEvent>
  implements ModuleRuntime<TPayload, TEvent> {
  #state: ModuleRuntimeState = "starting";
  readonly mode: "local" | "account";
  #coordinator: SyncCoordinator<TPayload, TEvent> | null;
  #operationGate: OperationGate | null;
  #lease: ModuleEditorLease | null;
  #poller: RevisionPoller | null = null;
  #unsubscribeAuth: (() => void) | null = null;
  #removePageHide: (() => void) | null = null;
  #commandTail: Promise<void> = Promise.resolve();
  #queuedCommands = 0;
  #disposePromise: Promise<void> | null = null;
  readonly #onSnapshotChange: ((snapshot: SyncCoordinatorSnapshot) => void) | null;

  constructor(
    coordinator: SyncCoordinator<TPayload, TEvent>,
    operationGate: OperationGate,
    lease: ModuleEditorLease,
    mode: "local" | "account",
    onSnapshotChange?: (snapshot: SyncCoordinatorSnapshot) => void,
  ) {
    this.#coordinator = coordinator;
    this.#operationGate = operationGate;
    this.#lease = lease;
    this.mode = mode;
    this.#onSnapshotChange = onSnapshotChange ?? null;
  }

  get state(): ModuleRuntimeState {
    return this.#state;
  }

  get current(): TPayload {
    return this.#requireReadyCoordinator().history.current;
  }

  get canUndo(): boolean {
    return this.#requireReadyCoordinator().history.canUndo;
  }

  get canRedo(): boolean {
    return this.#requireReadyCoordinator().history.canRedo;
  }

  get dirty(): boolean {
    return this.#requireReadyCoordinator().history.dirty;
  }

  markReady(): void {
    if (this.#state !== "starting") {
      throw new ModuleRuntimeUnavailableError(this.#state);
    }
    this.#state = "ready";
    this.#notifySnapshotChange();
  }

  attachLifecycle(options: {
    poller?: RevisionPoller;
    unsubscribeAuth?: () => void;
    removePageHide: () => void;
  }): void {
    this.#poller = options.poller ?? null;
    this.#unsubscribeAuth = options.unsubscribeAuth ?? null;
    this.#removePageHide = options.removePageHide;
  }

  dispatch(event: TEvent): TPayload {
    const coordinator = this.#requireReadyCoordinator();
    if (this.#queuedCommands > 0 || this.#operationGate!.busy) {
      throw new ModuleRuntimeBusyError();
    }
    const payload = coordinator.dispatch(event);
    this.#notifySnapshotChange();
    return payload;
  }

  undo(): Promise<TPayload> {
    return this.#enqueue((coordinator) => coordinator.undo());
  }

  redo(): Promise<TPayload> {
    return this.#enqueue((coordinator) => coordinator.redo());
  }

  save(): Promise<SyncActionResult> {
    return this.#enqueue((coordinator) => coordinator.saveLocal());
  }

  upload(): Promise<SyncActionResult> {
    return this.#enqueue((coordinator) =>
      conflictAsResult(() => coordinator.upload()));
  }

  pull(): Promise<SyncActionResult> {
    return this.#enqueue((coordinator) => coordinator.pull());
  }

  resolveConflict(strategy: ConflictResolution): Promise<SyncActionResult> {
    return this.#enqueue((coordinator) =>
      conflictAsResult(() => coordinator.resolveConflict(strategy)));
  }

  pollNow(): Promise<void> {
    this.#requireReadyCoordinator();
    return this.#poller?.pollNow() ?? Promise.resolve();
  }

  observeRemoteRevision(
    revision: RemoteRevisionSnapshot | null,
  ): Promise<SyncActionResult> {
    return this.#enqueue((coordinator) => coordinator.handleObservedRemoteRevision(revision));
  }

  getSnapshot(): SyncCoordinatorSnapshot {
    return this.#requireReadyCoordinator().getSnapshot();
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise;
    }

    this.#state = "disposing";
    const poller = this.#poller;
    this.#poller = null;
    const unsubscribeAuth = this.#unsubscribeAuth;
    this.#unsubscribeAuth = null;
    const removePageHide = this.#removePageHide;
    this.#removePageHide = null;
    const coordinator = this.#coordinator;
    this.#coordinator = null;
    const operationGate = this.#operationGate;
    this.#operationGate = null;
    const lease = this.#lease;
    this.#lease = null;

    this.#disposePromise = (async () => {
      let firstError: unknown;
      const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
        try {
          await cleanup();
        } catch (error) {
          firstError ??= error;
        }
      };

      await attempt(() => removePageHide?.());
      await attempt(() => unsubscribeAuth?.());
      await attempt(async () => poller?.stop());
      await attempt(async () => this.#commandTail);
      await attempt(async () => operationGate?.whenIdle());
      await attempt(() => coordinator?.close());
      await attempt(async () => lease?.release());
      this.#state = "disposed";
      if (firstError !== undefined) {
        throw firstError;
      }
    })();
    return this.#disposePromise;
  }

  #enqueue<R>(
    operation: (coordinator: SyncCoordinator<TPayload, TEvent>) => R | Promise<R>,
  ): Promise<R> {
    this.#requireReadyCoordinator();
    this.#queuedCommands += 1;
    const execute = async (): Promise<R> => {
      try {
        const coordinator = this.#requireReadyCoordinator();
        return await operation(coordinator);
      } finally {
        this.#queuedCommands -= 1;
        this.#notifySnapshotChange();
      }
    };
    const result = this.#commandTail.then(execute, execute);
    this.#commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requireReadyCoordinator(): SyncCoordinator<TPayload, TEvent> {
    if (this.#state !== "ready" || !this.#coordinator) {
      throw new ModuleRuntimeUnavailableError(this.#state);
    }
    return this.#coordinator;
  }

  #notifySnapshotChange(): void {
    if (
      this.#state !== "ready"
      || !this.#coordinator
      || !this.#onSnapshotChange
    ) {
      return;
    }

    try {
      this.#onSnapshotChange(this.#coordinator.getSnapshot());
    } catch {
      // Status observers cannot roll back or fail a completed runtime command.
    }
  }
}

async function conflictAsResult(
  operation: () => Promise<SyncActionResult>,
): Promise<SyncActionResult> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SyncConflictPendingError) {
      return "conflict";
    }
    throw error;
  }
}
