import { createAuthService, type AuthService } from "../auth";
import { ModuleEditorLease, OperationGate } from "../concurrency";
import {
  GitHubApiError,
  GitHubGitDataClient,
  RemoteModuleRepository,
  type GitHubFetch,
  type RemoteRevisionSnapshot,
} from "../github";
import { ModuleLocalStore, type PersistedConflict } from "../persistence";
import {
  createRevisionPoller,
  SyncConflictPendingError,
  SyncCoordinator,
  type ConflictResolution,
  type ModuleDefinition,
  type ProjectionReason,
  type RevisionPoller,
  type SettleReason,
  type SyncActionResult,
  type SyncCoordinatorSnapshot,
} from "../sync";
import { DomOperationGatePresentation, renderModuleEditorBlockPage } from "../ui";

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

class DefaultModuleRuntime<TPayload, TEvent>
  implements ModuleRuntime<TPayload, TEvent> {
  #state: ModuleRuntimeState = "starting";
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
    onSnapshotChange?: (snapshot: SyncCoordinatorSnapshot) => void,
  ) {
    this.#coordinator = coordinator;
    this.#operationGate = operationGate;
    this.#lease = lease;
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
    poller: RevisionPoller;
    unsubscribeAuth: () => void;
    removePageHide: () => void;
  }): void {
    this.#poller = options.poller;
    this.#unsubscribeAuth = options.unsubscribeAuth;
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

export async function startModuleRuntime<TPayload, TEvent>(
  options: StartModuleRuntimeOptions<TPayload, TEvent>,
  environment: ModuleRuntimeEnvironment = {},
): Promise<ModuleRuntimeStartResult<TPayload, TEvent>> {
  const pageDocument = environment.document ?? options.appRoot.ownerDocument;
  const pageWindow = environment.window ?? pageDocument.defaultView;
  if (!pageWindow) {
    throw new Error("A Window is required to start a module runtime.");
  }

  let authenticationNotificationSent = false;
  const notifyAuthenticationRequired = (): void => {
    if (authenticationNotificationSent) {
      return;
    }
    authenticationNotificationSent = true;
    if (environment.onAuthenticationRequired) {
      environment.onAuthenticationRequired();
      return;
    }
    pageWindow.location.replace(new URL(import.meta.env.BASE_URL, pageWindow.location.href).href);
  };

  const authService = environment.authService ?? createAuthService();
  const session = authService.restore();
  if (!session) {
    notifyAuthenticationRequired();
    return { status: "authentication-required" };
  }

  const lease = new ModuleEditorLease(options.definition.moduleId, {
    lockManager: environment.lockManager,
  });
  const leaseStatus = await lease.acquire();
  if (leaseStatus === "blocked" || leaseStatus === "unsupported") {
    renderModuleEditorBlockPage(options.appRoot, leaseStatus);
    return { status: leaseStatus };
  }
  if (leaseStatus !== "acquired") {
    await lease.release();
    throw new Error(`Unexpected module editor lease state: ${leaseStatus}`);
  }

  const cleanupStack: Array<() => void | Promise<void>> = [() => lease.release()];
  let runtime: DefaultModuleRuntime<TPayload, TEvent> | null = null;
  let runtimeOwnsLifecycle = false;

  try {
    const presentation = new DomOperationGatePresentation(options.appRoot, {
      document: pageDocument,
      cloudStatusLabel: options.cloudStatusLabel,
    });
    const operationGate = new OperationGate(presentation);
    const localStore = new ModuleLocalStore<TPayload>(options.definition.moduleId, {
      indexedDB: environment.indexedDB,
    });
    cleanupStack.push(() => localStore.close());
    cleanupStack.push(() => operationGate.whenIdle());

    const request = environment.fetch ?? globalThis.fetch.bind(globalThis);
    const client = new GitHubGitDataClient({
      owner: session.repository.owner,
      token: session.credentials.token,
      fetch: request,
      onCredentialsInvalid: () => authService.invalidate(),
    });
    const repository = new RemoteModuleRepository(client, options.definition, {
      now: environment.now,
    });
    const coordinator = new SyncCoordinator({
      definition: options.definition,
      localStore,
      remoteRepository: repository,
      operationGate,
      hooks: {
        settle: options.hooks.settle,
        project: options.hooks.project,
        onConflict: options.hooks.onConflict,
        reload: environment.reload ?? (() => pageWindow.location.reload()),
      },
      now: environment.now,
      createUuid: environment.createUuid,
    });
    const createdRuntime = new DefaultModuleRuntime(
      coordinator,
      operationGate,
      lease,
      options.hooks.onSnapshotChange,
    );
    runtime = createdRuntime;

    const initialPayload = await coordinator.initialize();
    createdRuntime.markReady();

    const poller = createRevisionPoller({
      document: pageDocument,
      window: pageWindow,
      random: environment.random,
      readRevision: (signal) => repository.readRevision(signal),
      onRevision: async (revision) => {
        await createdRuntime.observeRemoteRevision(revision);
      },
      isAuthenticationError: (error) => error instanceof GitHubApiError && error.status === 401,
      onAuthenticationError: () => authService.invalidate(),
    });
    cleanupStack.push(() => poller.stop());
    const unsubscribeAuth = authService.subscribe((state) => {
      if (state.status === "anonymous") {
        void createdRuntime.dispose().then(
          notifyAuthenticationRequired,
          notifyAuthenticationRequired,
        ).catch(() => undefined);
      }
    });
    cleanupStack.push(unsubscribeAuth);
    const onPageHide = (): void => {
      void createdRuntime.dispose().catch(() => undefined);
    };
    pageWindow.addEventListener("pagehide", onPageHide, { once: true });
    const removePageHide = (): void => pageWindow.removeEventListener("pagehide", onPageHide);
    cleanupStack.push(removePageHide);
    createdRuntime.attachLifecycle({
      poller,
      unsubscribeAuth,
      removePageHide,
    });
    runtimeOwnsLifecycle = true;
    cleanupStack.length = 0;

    if (authService.getState().status === "anonymous") {
      await createdRuntime.dispose().catch(() => undefined);
      notifyAuthenticationRequired();
      return { status: "authentication-required" };
    }
    if (environment.autoStartPolling !== false) {
      poller.start();
    }
    return { status: "ready", initialPayload, runtime: createdRuntime };
  } catch (error) {
    if (runtimeOwnsLifecycle && runtime) {
      await runtime.dispose().catch(() => undefined);
    } else {
      await runCleanupStack(cleanupStack);
    }
    if (authService.getState().status === "anonymous") {
      notifyAuthenticationRequired();
      return { status: "authentication-required" };
    }
    throw error;
  }
}

async function runCleanupStack(stack: Array<() => void | Promise<void>>): Promise<void> {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    try {
      await stack[index]?.();
    } catch {
      // Preserve the startup error while still attempting every remaining cleanup.
    }
  }
  stack.length = 0;
}
