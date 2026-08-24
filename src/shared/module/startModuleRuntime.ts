import { ModuleEditorLease, OperationGate } from "../concurrency";
import {
  GitHubApiError,
  GitHubGitDataClient,
  RemoteModuleRepository,
} from "../github";
import {
  createModuleLocalEnvelope,
  ModuleLocalStore,
} from "../persistence";
import { createDashboardProfileStore } from "../profiles";
import {
  createRevisionPoller,
  hashContentKey,
  SyncCoordinator,
  type RemoteModulePort,
} from "../sync";
import { DomOperationGatePresentation, renderModuleEditorBlockPage } from "../ui";
import { DefaultModuleRuntime } from "./DefaultModuleRuntime";
import { RuntimeAuthentication } from "./runtimeAuthentication";
import type {
  ModuleRuntimeEnvironment,
  ModuleRuntimeStartResult,
  StartModuleRuntimeOptions,
} from "./runtimeTypes";

export async function startModuleRuntime<TPayload, TEvent>(
  options: StartModuleRuntimeOptions<TPayload, TEvent>,
  environment: ModuleRuntimeEnvironment = {},
): Promise<ModuleRuntimeStartResult<TPayload, TEvent>> {
  const pageDocument = environment.document ?? options.appRoot.ownerDocument;
  const pageWindow = environment.window ?? pageDocument.defaultView;
  if (!pageWindow) {
    throw new Error("A Window is required to start a module runtime.");
  }

  const legacyAuthService = environment.authService;
  const profileStore = legacyAuthService
    ? null
    : environment.profileStore ?? createDashboardProfileStore();
  const profileContext = profileStore?.getActiveContext() ?? null;
  const authService = legacyAuthService ?? null;
  const profileId = legacyAuthService ? undefined : profileContext!.profileId;
  const runtimeAuthentication = new RuntimeAuthentication({
    authService,
    profileStore,
    profileId,
    pageWindow,
    onAuthenticationRequired: environment.onAuthenticationRequired,
  });
  const session = authService?.restore()
    ?? (profileContext?.mode === "account" ? profileContext.session : null);
  if (legacyAuthService && !session) {
    runtimeAuthentication.notifyRequired();
    return { status: "authentication-required" };
  }
  const mode: "local" | "account" = session ? "account" : "local";

  const lease = new ModuleEditorLease(options.definition.moduleId, {
    lockManager: environment.lockManager,
    profileId,
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
      profileId,
    });
    cleanupStack.push(() => localStore.close());
    cleanupStack.push(() => operationGate.whenIdle());
    if (mode === "local" && await localStore.load() === null) {
      const payload = options.definition.validate(options.definition.createEmpty());
      const contentHash = await hashContentKey(options.definition.contentKey(payload));
      const createdAt = (environment.now?.() ?? new Date()).toISOString();
      await localStore.initialize({
        ...createModuleLocalEnvelope(
          payload,
          contentHash,
          environment.createUuid?.(),
          options.definition.migration?.currentVersion ?? null,
        ),
        localSavedAt: createdAt,
      });
    }

    const request = environment.fetch ?? globalThis.fetch.bind(globalThis);
    const repository: RemoteModulePort<TPayload> = session
      ? new RemoteModuleRepository(
          new GitHubGitDataClient({
            owner: session.repository.owner,
            token: session.credentials.token,
            fetch: request,
            onCredentialsInvalid: () => runtimeAuthentication.invalidateCredentials(),
          }),
          options.definition,
          { now: environment.now },
        )
      : createLocalRemotePort(options.definition.moduleId);
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
      mode,
      options.hooks.onSnapshotChange,
    );
    runtime = createdRuntime;

    const initialPayload = await coordinator.initialize();
    createdRuntime.markReady();

    const poller = mode === "account"
      ? createRevisionPoller({
          document: pageDocument,
          window: pageWindow,
          random: environment.random,
          readRevision: (signal) => repository.readRevision(signal),
          onRevision: async (revision) => {
            await createdRuntime.observeRemoteRevision(revision);
          },
          isAuthenticationError: (error) => error instanceof GitHubApiError && error.status === 401,
          onAuthenticationError: () => runtimeAuthentication.invalidateCredentials(),
        })
      : null;
    if (poller) cleanupStack.push(() => poller.stop());
    const unsubscribeAuth = authService
      ? authService.subscribe((state) => {
          if (state.status === "anonymous") {
            runtimeAuthentication.requireAuthentication();
          }
        })
      : undefined;
    if (unsubscribeAuth) cleanupStack.push(unsubscribeAuth);
    const onPageHide = (): void => {
      void createdRuntime.dispose().catch(() => undefined);
    };
    pageWindow.addEventListener("pagehide", onPageHide, { once: true });
    const removePageHide = (): void => pageWindow.removeEventListener("pagehide", onPageHide);
    cleanupStack.push(removePageHide);
    createdRuntime.attachLifecycle({
      ...(poller ? { poller } : {}),
      ...(unsubscribeAuth ? { unsubscribeAuth } : {}),
      removePageHide,
    });
    runtimeOwnsLifecycle = true;
    cleanupStack.length = 0;
    runtimeAuthentication.attachRuntime(() => createdRuntime.dispose());

    if (authService?.getState().status === "anonymous") {
      await createdRuntime.dispose().catch(() => undefined);
      runtimeAuthentication.notifyRequired();
      return { status: "authentication-required" };
    }
    if (poller && environment.autoStartPolling !== false) {
      poller.start();
    }
    return { status: "ready", initialPayload, runtime: createdRuntime };
  } catch (error) {
    if (runtimeOwnsLifecycle && runtime) {
      await runtime.dispose().catch(() => undefined);
    } else {
      await runCleanupStack(cleanupStack);
    }
    if (authService?.getState().status === "anonymous") {
      runtimeAuthentication.notifyRequired();
      return { status: "authentication-required" };
    }
    if (runtimeAuthentication.credentialsInvalidated) {
      runtimeAuthentication.notifyRequired();
    }
    throw error;
  }
}

function createLocalRemotePort<T>(moduleId: string): RemoteModulePort<T> {
  const unavailable = (): never => {
    throw new Error("Cloud synchronization is unavailable in local mode.");
  };
  return {
    moduleId,
    readRevision: async () => null,
    pull: async () => null,
    push: async () => unavailable(),
    overwrite: async () => unavailable(),
    updateSchema: async () => unavailable(),
  };
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
