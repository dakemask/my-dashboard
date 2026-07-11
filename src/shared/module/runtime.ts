import { createAuthService, type AuthService } from "../auth";
import { ModuleEditorLease, OperationGate } from "../concurrency";
import {
  GitHubApiError,
  GitHubGitDataClient,
  RemoteModuleRepository,
  type GitHubFetch,
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

export type ModuleRuntimeCommand =
  | "undo"
  | "redo"
  | "save"
  | "upload"
  | "pull"
  | "resolve-conflict"
  | "poll";

export interface ModuleRuntimeHooks<T> {
  /** Ends or cancels live UI interaction before a shared action reads the payload. */
  settle(reason: SettleReason): T | null | Promise<T | null>;
  /** Rebuilds the module UI after initialization, undo, or redo. */
  project(payload: T, reason: ProjectionReason): void;
  onConflict?(conflict: PersistedConflict): void;
  /** Receives errors raised by keyboard-triggered commands. Direct method calls reject normally. */
  onCommandError?(error: unknown, command: ModuleRuntimeCommand): void;
}

export interface StartModuleRuntimeOptions<T> {
  readonly definition: ModuleDefinition<T>;
  readonly appRoot: HTMLElement;
  readonly hooks: ModuleRuntimeHooks<T>;
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

export interface ModuleRuntime<T> {
  readonly state: ModuleRuntimeState;
  readonly current: T;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  commit(payload: T): T;
  undo(): Promise<T>;
  redo(): Promise<T>;
  save(): Promise<SyncActionResult>;
  upload(): Promise<SyncActionResult>;
  pull(): Promise<SyncActionResult>;
  resolveConflict(strategy: ConflictResolution): Promise<SyncActionResult>;
  pollNow(): Promise<void>;
  getSnapshot(): SyncCoordinatorSnapshot;
  dispose(): Promise<void>;
}

export type ModuleRuntimeStartResult<T> =
  | { readonly status: "ready"; readonly initialPayload: T; readonly runtime: ModuleRuntime<T> }
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

class DefaultModuleRuntime<T> implements ModuleRuntime<T> {
  #state: ModuleRuntimeState = "starting";
  #coordinator: SyncCoordinator<T> | null;
  #operationGate: OperationGate | null;
  #lease: ModuleEditorLease | null;
  #poller: RevisionPoller | null = null;
  #removeShortcuts: (() => void) | null = null;
  #unsubscribeAuth: (() => void) | null = null;
  #removePageHide: (() => void) | null = null;
  #commandTail: Promise<void> = Promise.resolve();
  #queuedCommands = 0;
  #disposePromise: Promise<void> | null = null;
  readonly #onCommandError: ModuleRuntimeHooks<T>["onCommandError"];

  constructor(
    coordinator: SyncCoordinator<T>,
    operationGate: OperationGate,
    lease: ModuleEditorLease,
    onCommandError: ModuleRuntimeHooks<T>["onCommandError"],
  ) {
    this.#coordinator = coordinator;
    this.#operationGate = operationGate;
    this.#lease = lease;
    this.#onCommandError = onCommandError;
  }

  get state(): ModuleRuntimeState {
    return this.#state;
  }

  get current(): T {
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
  }

  attachLifecycle(options: {
    poller: RevisionPoller;
    removeShortcuts: () => void;
    unsubscribeAuth: () => void;
    removePageHide: () => void;
  }): void {
    this.#poller = options.poller;
    this.#removeShortcuts = options.removeShortcuts;
    this.#unsubscribeAuth = options.unsubscribeAuth;
    this.#removePageHide = options.removePageHide;
  }

  commit(payload: T): T {
    const coordinator = this.#requireReadyCoordinator();
    if (this.#queuedCommands > 0 || this.#operationGate!.busy) {
      throw new ModuleRuntimeBusyError();
    }
    return coordinator.commit(payload);
  }

  undo(): Promise<T> {
    return this.#enqueue("undo", (coordinator) => coordinator.undo());
  }

  redo(): Promise<T> {
    return this.#enqueue("redo", (coordinator) => coordinator.redo());
  }

  save(): Promise<SyncActionResult> {
    return this.#enqueue("save", (coordinator) => coordinator.saveLocal());
  }

  upload(): Promise<SyncActionResult> {
    return this.#enqueue("upload", (coordinator) =>
      conflictAsResult(() => coordinator.upload()));
  }

  pull(): Promise<SyncActionResult> {
    return this.#enqueue("pull", (coordinator) => coordinator.pull());
  }

  resolveConflict(strategy: ConflictResolution): Promise<SyncActionResult> {
    return this.#enqueue("resolve-conflict", (coordinator) =>
      conflictAsResult(() => coordinator.resolveConflict(strategy)));
  }

  pollNow(): Promise<void> {
    this.#requireReadyCoordinator();
    return this.#poller?.pollNow() ?? Promise.resolve();
  }

  observeRemoteRevision(revision: string | null): Promise<SyncActionResult> {
    return this.#enqueue("poll", (coordinator) => coordinator.handleObservedRemoteRevision(revision));
  }

  getSnapshot(): SyncCoordinatorSnapshot {
    return this.#requireReadyCoordinator().getSnapshot();
  }

  reportShortcutError(error: unknown, command: "undo" | "redo"): void {
    this.#onCommandError?.(error, command);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise;
    }

    this.#state = "disposing";
    const poller = this.#poller;
    this.#poller = null;
    const removeShortcuts = this.#removeShortcuts;
    this.#removeShortcuts = null;
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
      await attempt(() => removeShortcuts?.());
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
    _command: ModuleRuntimeCommand,
    operation: (coordinator: SyncCoordinator<T>) => R | Promise<R>,
  ): Promise<R> {
    this.#requireReadyCoordinator();
    this.#queuedCommands += 1;
    const execute = async (): Promise<R> => {
      try {
        const coordinator = this.#requireReadyCoordinator();
        return await operation(coordinator);
      } finally {
        this.#queuedCommands -= 1;
      }
    };
    const result = this.#commandTail.then(execute, execute);
    this.#commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #requireReadyCoordinator(): SyncCoordinator<T> {
    if (this.#state !== "ready" || !this.#coordinator) {
      throw new ModuleRuntimeUnavailableError(this.#state);
    }
    return this.#coordinator;
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

export async function startModuleRuntime<T>(
  options: StartModuleRuntimeOptions<T>,
  environment: ModuleRuntimeEnvironment = {},
): Promise<ModuleRuntimeStartResult<T>> {
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
  let runtime: DefaultModuleRuntime<T> | null = null;
  let runtimeOwnsLifecycle = false;

  try {
    const presentation = new DomOperationGatePresentation(options.appRoot, {
      document: pageDocument,
      cloudStatusLabel: options.cloudStatusLabel,
    });
    const operationGate = new OperationGate(presentation);
    const localStore = new ModuleLocalStore<T>(options.definition.moduleId, {
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
      options.hooks.onCommandError,
    );
    runtime = createdRuntime;

    const initialPayload = await coordinator.initialize();
    createdRuntime.markReady();

    const poller = createRevisionPoller({
      document: pageDocument,
      window: pageWindow,
      random: environment.random,
      readRevision: async (signal) => (await repository.readRevision(signal))?.revision ?? null,
      onRevision: async (revision) => {
        await createdRuntime.observeRemoteRevision(revision);
      },
      isAuthenticationError: (error) => error instanceof GitHubApiError && error.status === 401,
      onAuthenticationError: () => authService.invalidate(),
    });
    cleanupStack.push(() => poller.stop());
    const removeShortcuts = installRuntimeShortcuts(createdRuntime, pageDocument);
    cleanupStack.push(removeShortcuts);
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
      removeShortcuts,
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

function installRuntimeShortcuts<T>(
  runtime: DefaultModuleRuntime<T>,
  target: Document,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      !event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") {
      return;
    }

    event.preventDefault();
    const command = key === "z" ? "undo" : "redo";
    const action = command === "undo" ? runtime.undo() : runtime.redo();
    void action.catch((error: unknown) => runtime.reportShortcutError(error, command));
  };
  const listener = onKeyDown as EventListener;
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}
