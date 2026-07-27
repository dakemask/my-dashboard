import type { AuthSession } from "../shared/auth";
import { OperationGate } from "../shared/concurrency";
import {
  GitHubGitDataClient,
  RemoteModuleRepository,
  type RemoteModuleSnapshot,
} from "../shared/github";
import {
  createLocalRevision,
  createModuleLocalEnvelope,
  ModuleLocalStore,
} from "../shared/persistence";
import { hashContentKey, SyncCoordinator, type ModuleDefinition } from "../shared/sync";
import { persistentDashboardDefinitions } from "./modules";

export type FirstAccountDirection = "local-wins" | "cloud-wins";

export interface FirstAccountInspection {
  readonly localHasData: boolean;
  readonly cloudHasData: boolean;
  readonly needsChoice: boolean;
  readonly suggestedDirection: FirstAccountDirection;
}

export async function inspectFirstAccount(
  session: AuthSession,
  request: typeof fetch = fetch,
): Promise<FirstAccountInspection> {
  const client = createClient(session, request);
  const inspections = await Promise.all(
    persistentDashboardDefinitions.map((definition) =>
      inspectModule(eraseDefinition(definition), client)),
  );
  const localHasData = inspections.some((inspection) => inspection.localHasData);
  const cloudHasData = inspections.some((inspection) => inspection.cloudHasData);
  return {
    localHasData,
    cloudHasData,
    needsChoice: localHasData && cloudHasData,
    suggestedDirection: localHasData ? "local-wins" : "cloud-wins",
  };
}

export async function bindFirstAccount(
  session: AuthSession,
  profileId: string,
  direction: FirstAccountDirection,
  request: typeof fetch = fetch,
): Promise<void> {
  const client = createClient(session, request);
  for (const definition of persistentDashboardDefinitions) {
    await bindModule(eraseDefinition(definition), client, profileId, direction);
  }
}

export async function clearLocalProfile(): Promise<void> {
  await Promise.allSettled(
    persistentDashboardDefinitions.map((definition) =>
      deleteLocalModule(definition.moduleId)),
  );
}

function createClient(session: AuthSession, request: typeof fetch): GitHubGitDataClient {
  return new GitHubGitDataClient({
    owner: session.repository.owner,
    token: session.credentials.token,
    fetch: request,
    onCredentialsInvalid: () => undefined,
  });
}

async function inspectModule<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
  client: GitHubGitDataClient,
): Promise<{ localHasData: boolean; cloudHasData: boolean }> {
  const localStore = new ModuleLocalStore<TPayload>(definition.moduleId, {
    profileId: "local",
  });
  const repository = new RemoteModuleRepository(client, definition);
  try {
    const [local, remote] = await Promise.all([
      localStore.load(),
      repository.pull(),
    ]);
    const emptyKey = definition.contentKey(definition.createEmpty());
    const localHasData = local
      ? definition.contentKey(preparePayload(definition, local.payload, local.schemaVersion)) !== emptyKey
      : false;
    const cloudHasData = remote
      ? definition.contentKey(prepareRemotePayload(definition, remote)) !== emptyKey
      : false;
    return { localHasData, cloudHasData };
  } finally {
    localStore.close();
  }
}

async function bindModule<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
  client: GitHubGitDataClient,
  profileId: string,
  direction: FirstAccountDirection,
): Promise<void> {
  const targetStore = new ModuleLocalStore<TPayload>(definition.moduleId, {
    profileId,
  });
  await targetStore.deleteDatabase();
  const sourceStore = new ModuleLocalStore<TPayload>(definition.moduleId, {
    profileId: "local",
  });
  const repository = new RemoteModuleRepository(client, definition);
  try {
    if (direction === "local-wins") {
      const source = await sourceStore.load();
      const payload = source
        ? preparePayload(definition, source.payload, source.schemaVersion)
        : definition.createEmpty();
      const contentHash = await hashContentKey(definition.contentKey(payload));
      const initial = {
        ...createModuleLocalEnvelope(
          payload,
          contentHash,
          createLocalRevision(),
          definition.migration?.currentVersion ?? null,
        ),
        localSavedAt: new Date().toISOString(),
      };
      await targetStore.initialize(initial);
    }

    const coordinator = new SyncCoordinator({
      definition,
      localStore: targetStore,
      remoteRepository: repository,
      operationGate: new OperationGate(),
      hooks: {
        settle: () => null,
        project: () => undefined,
        reload: () => undefined,
      },
    });
    try {
      await coordinator.initialize();
      if (direction === "local-wins") {
        await coordinator.resolveConflict("local-wins");
      }
    } finally {
      coordinator.close();
    }
  } finally {
    sourceStore.close();
    targetStore.close();
  }
}

async function deleteLocalModule(moduleId: string): Promise<void> {
  const store = new ModuleLocalStore(moduleId, { profileId: "local" });
  await store.deleteDatabase();
}

function prepareRemotePayload<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
  remote: RemoteModuleSnapshot<TPayload>,
): TPayload {
  return preparePayload(definition, remote.data, remote.schemaVersion ?? null);
}

function preparePayload<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
  value: unknown,
  observedVersion: number | null,
): TPayload {
  const migration = definition.migration;
  if (!migration) return definition.validate(value);
  if (!Number.isSafeInteger(observedVersion) || observedVersion === null || observedVersion < 1) {
    throw new Error("模块数据缺少有效的 schemaVersion。");
  }
  if (observedVersion > migration.currentVersion) {
    throw new Error("模块数据版本高于当前网页支持的版本。");
  }
  let payload = structuredClone(value);
  for (let version = observedVersion; version < migration.currentVersion; version += 1) {
    payload = migration.migrate(payload, version);
  }
  return definition.validate(payload);
}

function eraseDefinition(
  definition: (typeof persistentDashboardDefinitions)[number],
): ModuleDefinition<unknown, unknown> {
  return definition as unknown as ModuleDefinition<unknown, unknown>;
}
