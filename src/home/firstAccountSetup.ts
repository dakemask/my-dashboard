import type { AuthSession } from "../shared/auth";
import { OperationGate } from "../shared/concurrency";
import {
  GitHubApiError,
  GitHubGitDataClient,
  RemoteModuleFormatError,
  RemoteModuleRepository,
  type RemoteRevisionSnapshot,
} from "../shared/github";
import {
  createLocalRevision,
  createModuleLocalEnvelope,
  ModuleLocalStore,
} from "../shared/persistence";
import {
  hashModulePayload,
  getModuleContentKey,
  prepareCurrentModulePayload,
  prepareStoredModulePayload,
  type PreparedModulePayload,
} from "../shared/sync/modulePayload";
import {
  LocalDataIntegrityError,
  MissingModuleSchemaVersionError,
  ModuleMigrationError,
  SyncCoordinator,
  UnsupportedModuleSchemaVersionError,
  type ModuleDefinition,
} from "../shared/sync";
import {
  getDashboardModuleTitle,
  persistentDashboardDefinitions,
} from "./modules";

export type FirstAccountDirection = "local-wins" | "cloud-wins";

export interface FirstAccountInspection {
  readonly localHasData: boolean;
  readonly cloudHasData: boolean;
  readonly needsChoice: boolean;
  readonly suggestedDirection: FirstAccountDirection;
}

interface AccountSetupErrorOptions {
  readonly remoteMayBePartiallyUpdated?: boolean;
}

export class AccountSetupError extends Error {
  readonly remoteMayBePartiallyUpdated: boolean;

  constructor(
    readonly stage: "inspect" | FirstAccountDirection,
    readonly moduleId: string,
    readonly detail: string,
    options: AccountSetupErrorOptions = {},
  ) {
    const action = stage === "inspect"
      ? "检查"
      : stage === "local-wins"
        ? "上传"
        : "拉取";
    const retryNotice = options.remoteMayBePartiallyUpdated
      ? " 云端可能已经更新了部分模块；这些更新不会自动回滚，请保持“本地覆盖云端”方向重试。"
      : "";
    super(`无法${action}${moduleLabel(moduleId)}数据：${detail}${retryNotice}`);
    this.name = "AccountSetupError";
    this.remoteMayBePartiallyUpdated = options.remoteMayBePartiallyUpdated ?? false;
  }
}

interface LocalModulePreflight<TPayload> {
  readonly payload: TPayload;
  readonly contentHash: string;
  readonly hasData: boolean;
}

interface RemoteModulePreflight<TPayload> {
  readonly prepared: PreparedModulePayload<TPayload>;
  readonly contentHash: string;
  readonly hasData: boolean;
  readonly canonicalEmptyRevision: RemoteRevisionSnapshot | null;
}

interface ModulePreflight<TPayload = unknown, TEvent = unknown> {
  readonly definition: ModuleDefinition<TPayload, TEvent>;
  readonly local: LocalModulePreflight<TPayload>;
  readonly remote: RemoteModulePreflight<TPayload>;
}

export async function inspectFirstAccount(
  session: AuthSession,
  request: typeof fetch = fetch,
): Promise<FirstAccountInspection> {
  const preflight = await preflightDashboard(createClient(session, request));
  const localHasData = preflight.some(({ local }) => local.hasData);
  const cloudHasData = preflight.some(({ remote }) => remote.hasData);
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
  assertAccountProfileId(profileId);
  const client = createClient(session, request);
  let preflight: readonly ModulePreflight[];
  try {
    // This deliberately repeats the earlier inspection. Binding has its own
    // read-only safety boundary so no target database or remote module changes
    // until every module still validates at the moment the user confirms.
    preflight = await preflightDashboard(client);
  } catch (error) {
    await clearAccountProfile(profileId);
    throw error;
  }

  let remoteAlreadyUpdated = false;
  try {
    for (const module of preflight) {
      await bindPreflightedModule(module, client, profileId, direction);
      remoteAlreadyUpdated ||= direction === "local-wins";
    }
  } catch (error) {
    await clearAccountProfile(profileId);
    if (error instanceof AccountSetupError) {
      const remoteMayBePartiallyUpdated = direction === "local-wins"
        && (remoteAlreadyUpdated || error.remoteMayBePartiallyUpdated);
      if (remoteMayBePartiallyUpdated !== error.remoteMayBePartiallyUpdated) {
        throw new AccountSetupError(error.stage, error.moduleId, error.detail, {
          remoteMayBePartiallyUpdated,
        });
      }
    }
    throw error;
  }
}

/** Removes an unregistered account profile after setup or registration fails. */
export async function clearAccountProfile(profileId: string): Promise<void> {
  assertAccountProfileId(profileId);
  await clearProfile(profileId);
}

/** Compatibility helper used after the first account has been registered. */
export async function clearLocalProfile(): Promise<void> {
  await clearProfile("local");
}

function createClient(session: AuthSession, request: typeof fetch): GitHubGitDataClient {
  return new GitHubGitDataClient({
    owner: session.repository.owner,
    token: session.credentials.token,
    fetch: request,
    onCredentialsInvalid: () => undefined,
  });
}

async function preflightDashboard(
  client: GitHubGitDataClient,
): Promise<readonly ModulePreflight[]> {
  const settled = await Promise.allSettled(
    persistentDashboardDefinitions.map((definition) =>
      preflightModule(definition, client)),
  );
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<ModulePreflight>).value);
}

async function preflightModule<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
  client: GitHubGitDataClient,
): Promise<ModulePreflight<TPayload, TEvent>> {
  const localStore = new ModuleLocalStore<TPayload>(definition.moduleId, {
    profileId: "local",
  });
  const repository = new RemoteModuleRepository(client, definition);
  try {
    // Settle both reads before reporting either failure. This keeps the
    // dashboard-wide preflight truly read-only and exhaustive.
    const [localResult, remoteResult] = await Promise.allSettled([
      inspectLocalModule(definition, localStore),
      inspectRemoteModule(definition, repository),
    ] as const);
    if (localResult.status === "rejected") {
      throw new AccountSetupError(
        "inspect",
        definition.moduleId,
        describeSetupFailure(localResult.reason, "local"),
      );
    }
    if (remoteResult.status === "rejected") {
      throw new AccountSetupError(
        "inspect",
        definition.moduleId,
        describeSetupFailure(remoteResult.reason, "remote"),
      );
    }
    return {
      definition,
      local: localResult.value,
      remote: remoteResult.value,
    };
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

async function inspectLocalModule<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
  localStore: ModuleLocalStore<TPayload>,
): Promise<LocalModulePreflight<TPayload>> {
  const emptyPayload = prepareCurrentModulePayload(
    definition,
    definition.createEmpty(),
  );
  const emptyKey = getModuleContentKey(definition, emptyPayload);
  const local = await localStore.load();
  if (!local) {
    return {
      payload: emptyPayload,
      contentHash: await hashModulePayload(definition, emptyPayload),
      hasData: false,
    };
  }

  const prepared = prepareStoredModulePayload(
    definition,
    local.payload,
    local.schemaVersion,
    "local",
  );
  const contentHash = await hashModulePayload(definition, prepared.payload);
  if (!prepared.migrated && contentHash !== local.contentHash) {
    throw new LocalDataIntegrityError();
  }
  return {
    payload: prepared.payload,
    contentHash,
    hasData: getModuleContentKey(definition, prepared.payload) !== emptyKey,
  };
}

async function inspectRemoteModule<TPayload, TEvent>(
  definition: ModuleDefinition<TPayload, TEvent>,
  repository: RemoteModuleRepository<TPayload>,
): Promise<RemoteModulePreflight<TPayload>> {
  const emptyPayload = prepareCurrentModulePayload(
    definition,
    definition.createEmpty(),
  );
  const emptyKey = getModuleContentKey(definition, emptyPayload);
  const revision = await repository.readRevision();

  if (revision?.managedFiles.length === 0) {
    const prepared = prepareStoredModulePayload(
      definition,
      emptyPayload,
      revision.schemaVersion ?? null,
      "remote",
    );
    return {
      prepared,
      contentHash: await hashModulePayload(definition, prepared.payload),
      hasData: false,
      canonicalEmptyRevision: revision,
    };
  }

  const remote = revision ? await repository.pull() : null;
  if (revision && !remote) {
    throw new RemoteModuleFormatError(
      "The remote module disappeared during first-account preflight.",
    );
  }
  const prepared = prepareStoredModulePayload(
    definition,
    remote?.data ?? emptyPayload,
    remote
      ? remote.schemaVersion ?? null
      : definition.migration?.currentVersion ?? null,
    "remote",
  );
  return {
    prepared,
    contentHash: await hashModulePayload(definition, prepared.payload),
    hasData: getModuleContentKey(definition, prepared.payload) !== emptyKey,
    canonicalEmptyRevision: null,
  };
}

async function bindPreflightedModule<TPayload, TEvent>(
  preflight: ModulePreflight<TPayload, TEvent>,
  client: GitHubGitDataClient,
  profileId: string,
  direction: FirstAccountDirection,
): Promise<void> {
  const { definition } = preflight;
  const targetStore = new ModuleLocalStore<TPayload>(definition.moduleId, {
    profileId,
  });
  const repository = new RemoteModuleRepository(client, definition);
  let remoteMayBePartiallyUpdated = false;
  try {
    await targetStore.deleteDatabase();
    if (direction === "local-wins") {
      await targetStore.initialize({
        ...createModuleLocalEnvelope(
          preflight.local.payload,
          preflight.local.contentHash,
          createLocalRevision(),
          definition.migration?.currentVersion ?? null,
        ),
        localSavedAt: new Date().toISOString(),
      });
    } else if (preflight.remote.canonicalEmptyRevision) {
      const revision = preflight.remote.canonicalEmptyRevision;
      const prepared = preflight.remote.prepared;
      await targetStore.initialize({
        ...createModuleLocalEnvelope(
          prepared.payload,
          preflight.remote.contentHash,
          createLocalRevision(),
          definition.migration?.currentVersion ?? null,
        ),
        localSavedAt: new Date().toISOString(),
        lastSyncedContentHash: preflight.remote.contentHash,
        lastSyncedRemoteRevision: revision.revision,
        lastSyncedRemoteUpdatedAt: revision.updatedAt,
        migration: prepared.migrated
          ? {
              fromVersion: prepared.fromVersion!,
              toVersion: prepared.toVersion!,
              migratedContentHash: preflight.remote.contentHash,
              businessChanged: false,
            }
          : null,
      });
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
        // Once overwrite starts, a lost response can make the remote outcome
        // unknowable. The caller must offer an idempotent same-direction retry.
        remoteMayBePartiallyUpdated = true;
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
      { remoteMayBePartiallyUpdated },
    );
  } finally {
    targetStore.close();
  }
}

async function clearProfile(profileId: string): Promise<void> {
  await Promise.allSettled(
    persistentDashboardDefinitions.map(async ({ moduleId }) => {
      const store = new ModuleLocalStore(moduleId, { profileId });
      await store.deleteDatabase();
    }),
  );
}

function assertAccountProfileId(profileId: string): void {
  if (profileId === "local") {
    throw new TypeError("The local source profile cannot be used as a temporary account profile.");
  }
}

function moduleLabel(moduleId: string): string {
  return getDashboardModuleTitle(moduleId) ?? `模块 ${moduleId}`;
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
