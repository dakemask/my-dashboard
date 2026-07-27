import type { AuthSession } from "../shared/auth";
import { OperationGate } from "../shared/concurrency";
import {
  GitHubGitDataClient,
  GitHubApiError,
  RemoteModuleRepository,
  RemoteModuleFormatError,
  type RemoteRevisionSnapshot,
  type RemoteModuleSnapshot,
} from "../shared/github";
import {
  createLocalRevision,
  createModuleLocalEnvelope,
  ModuleLocalStore,
} from "../shared/persistence";
import {
  hashContentKey,
  LocalDataIntegrityError,
  MissingModuleSchemaVersionError,
  ModuleMigrationError,
  SyncCoordinator,
  UnsupportedModuleSchemaVersionError,
  type ModuleDefinition,
} from "../shared/sync";
import { persistentDashboardDefinitions } from "./modules";

export type FirstAccountDirection = "local-wins" | "cloud-wins";

export interface FirstAccountInspection {
  readonly localHasData: boolean;
  readonly cloudHasData: boolean;
  readonly needsChoice: boolean;
  readonly suggestedDirection: FirstAccountDirection;
}

export class AccountSetupError extends Error {
  constructor(
    readonly stage: "inspect" | FirstAccountDirection,
    readonly moduleId: string,
    readonly detail: string,
  ) {
    const action = stage === "inspect"
      ? "检查"
      : stage === "local-wins"
        ? "上传"
        : "拉取";
    super(`无法${action}${moduleLabel(moduleId)}数据：${detail}`);
    this.name = "AccountSetupError";
  }
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
    const emptyKey = definition.contentKey(definition.createEmpty());
    let localHasData: boolean;
    try {
      const local = await localStore.load();
      localHasData = local
        ? definition.contentKey(
            preparePayload(definition, local.payload, local.schemaVersion, "local"),
          ) !== emptyKey
        : false;
    } catch (error) {
      throw new AccountSetupError(
        "inspect",
        definition.moduleId,
        describeSetupFailure(error, "local"),
      );
    }

    let cloudHasData: boolean;
    try {
      const emptyRemote = await readCanonicalEmptyRemote(definition, repository);
      if (emptyRemote) {
        cloudHasData = false;
      } else {
        const remote = await repository.pull();
        cloudHasData = remote
          ? definition.contentKey(prepareRemotePayload(definition, remote)) !== emptyKey
          : false;
      }
    } catch (error) {
      throw new AccountSetupError(
        "inspect",
        definition.moduleId,
        describeSetupFailure(error, "remote"),
      );
    }
    return { localHasData, cloudHasData };
  } catch (error) {
    if (error instanceof AccountSetupError) throw error;
    throw new AccountSetupError(
      "inspect",
      definition.moduleId,
      describeSetupFailure(error),
    );
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
        ? preparePayload(definition, source.payload, source.schemaVersion, "local")
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
    } else {
      const emptyRemote = await readCanonicalEmptyRemote(definition, repository);
      if (emptyRemote) {
        const payload = preparePayload(
          definition,
          definition.createEmpty(),
          emptyRemote.schemaVersion ?? null,
          "remote",
        );
        const contentHash = await hashContentKey(definition.contentKey(payload));
        await targetStore.initialize({
          ...createModuleLocalEnvelope(
            payload,
            contentHash,
            createLocalRevision(),
            definition.migration?.currentVersion ?? null,
          ),
          localSavedAt: new Date().toISOString(),
          lastSyncedContentHash: contentHash,
          lastSyncedRemoteRevision: emptyRemote.revision,
          lastSyncedRemoteUpdatedAt: emptyRemote.updatedAt,
        });
      }
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
  } catch (error) {
    throw new AccountSetupError(
      direction,
      definition.moduleId,
      describeSetupFailure(error),
    );
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
  return preparePayload(
    definition,
    remote.data,
    remote.schemaVersion ?? null,
    "remote",
  );
}

async function readCanonicalEmptyRemote<TPayload, TEvent>(
  _definition: ModuleDefinition<TPayload, TEvent>,
  repository: RemoteModuleRepository<TPayload>,
): Promise<RemoteRevisionSnapshot | null> {
  const revision = await repository.readRevision();
  return revision?.managedFiles.length === 0 ? revision : null;
}

function preparePayload<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
  value: unknown,
  observedVersion: number | null,
  source: "local" | "remote",
): TPayload {
  const migration = definition.migration;
  if (!migration) return definition.validate(value);
  if (!Number.isSafeInteger(observedVersion) || observedVersion === null || observedVersion < 1) {
    throw new MissingModuleSchemaVersionError(source);
  }
  if (observedVersion > migration.currentVersion) {
    throw new UnsupportedModuleSchemaVersionError(
      observedVersion,
      migration.currentVersion,
    );
  }
  let payload = structuredClone(value);
  try {
    for (let version = observedVersion; version < migration.currentVersion; version += 1) {
      payload = migration.migrate(payload, version);
    }
  } catch {
    throw new ModuleMigrationError("Module data migration failed.");
  }
  return definition.validate(payload);
}

function eraseDefinition(
  definition: (typeof persistentDashboardDefinitions)[number],
): ModuleDefinition<unknown, unknown> {
  return definition as unknown as ModuleDefinition<unknown, unknown>;
}

function moduleLabel(moduleId: string): string {
  if (moduleId === "mind-maps") return "思维导图";
  if (moduleId === "fragment-thoughts") return "碎片想法";
  return `模块 ${moduleId}`;
}

function describeSetupFailure(
  error: unknown,
  source?: "local" | "remote",
): string {
  if (error instanceof MissingModuleSchemaVersionError) {
    return error.source === "local"
      ? "本机缓存缺少 schemaVersion。"
      : "云端 revision.json 缺少 schemaVersion。";
  }
  if (error instanceof UnsupportedModuleSchemaVersionError) {
    return "数据版本高于当前网页支持的版本。";
  }
  if (error instanceof LocalDataIntegrityError) {
    return "本机缓存未通过完整性校验。";
  }
  if (error instanceof ModuleMigrationError) {
    return "数据版本迁移失败。";
  }
  if (error instanceof RemoteModuleFormatError) {
    return "云端 revision.json 或受管文件清单无效。";
  }
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return "GitHub 凭据已经失效。";
    if (error.status === 403) return "GitHub 拒绝了读取请求或请求受到限流。";
    if (error.status === 404) return "无法读取数据仓库、分支或受管文件。";
    return `GitHub 读取失败（${error.status}）。`;
  }
  if (error instanceof DOMException) {
    return "浏览器本机存储操作失败。";
  }
  if (error instanceof TypeError) {
    return source === "local"
      ? "本机缓存的业务 payload 格式无效。"
      : source === "remote"
        ? "云端受管业务文件的内容格式无效。"
        : "模块业务数据格式无效。";
  }
  return "检查过程中发生未知错误。";
}
