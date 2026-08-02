import { GitHubGitDataClient } from "./client";
import {
  GitHubApiError,
  GitHubRefUpdateRaceError,
  RemoteModuleConflictError,
  RemoteModuleFormatError,
  RemoteModulePathError,
  type GitHubCreateTreeEntry,
  type GitHubTreeEntry,
  type GitHubTreeSnapshot,
  type RemoteModuleCodec,
  type RemoteModuleOverwriteOptions,
  type RemoteModulePushOptions,
  type RemoteModulePushResult,
  type RemoteModuleRevision,
  type RemoteModuleSnapshot,
  type RemoteRevisionSnapshot,
} from "./types";
import {
  isIsoDate,
  parseRemoteModuleManifest,
  serializeRemoteModuleManifest,
  toRemoteRevisionSnapshot,
  validateRemoteSchemaVersion,
  validateRevisionToken,
} from "./remoteModuleManifest";
import {
  compareRemoteModulePaths,
  getModuleRoot,
  getRemoteModuleFilePath,
  getRemoteModuleRevisionPath,
  remoteModulePathsCollide,
  validateEncodedFiles,
  validateModuleId,
} from "./remoteModulePaths";

export { getModuleRoot, validateModuleId } from "./remoteModulePaths";

interface LoadedHead {
  snapshot: GitHubTreeSnapshot;
  revision: RemoteModuleRevision | null;
  blobByPath: ReadonlyMap<string, GitHubTreeEntry>;
}

interface RemoteModuleRepositoryOptions {
  /** Number of ref-race retries after the initial attempt. */
  maxRefRetries?: number;
  now?: () => Date;
}

const DEFAULT_MAX_REF_RETRIES = 3;

export class RemoteModuleRepository<T> {
  readonly moduleId: string;
  readonly moduleRoot: string;

  readonly #client: GitHubGitDataClient;
  readonly #codec: RemoteModuleCodec<T>;
  readonly #maxRefRetries: number;
  readonly #now: () => Date;

  constructor(
    client: GitHubGitDataClient,
    codec: RemoteModuleCodec<T>,
    options: RemoteModuleRepositoryOptions = {},
  ) {
    this.moduleId = validateModuleId(codec.moduleId);
    this.moduleRoot = getModuleRoot(this.moduleId);
    this.#client = client;
    this.#codec = codec;
    this.#maxRefRetries = options.maxRefRetries ?? DEFAULT_MAX_REF_RETRIES;
    this.#now = options.now ?? (() => new Date());

    if (!Number.isSafeInteger(this.#maxRefRetries) || this.#maxRefRetries < 0) {
      throw new TypeError("maxRefRetries must be a non-negative safe integer.");
    }
  }

  async readRevision(signal?: AbortSignal): Promise<RemoteRevisionSnapshot | null> {
    const head = await this.#loadHead(signal);
    return head.revision
      ? toRemoteRevisionSnapshot(head.revision, head.snapshot.commitSha)
      : null;
  }

  async pull(): Promise<RemoteModuleSnapshot<T> | null> {
    const head = await this.#loadHead();

    if (!head.revision) {
      return null;
    }

    const files = new Map<string, string>();
    await Promise.all(
      head.revision.managedFiles.map(async (relativePath) => {
        const fullPath = this.#fullPath(relativePath);
        const entry = head.blobByPath.get(fullPath);

        if (!entry) {
          throw new RemoteModuleFormatError(`Managed file is missing from the revision snapshot: ${relativePath}`);
        }

        files.set(relativePath, await this.#client.readBlobText(entry.sha));
      }),
    );

    const stableFiles = new Map(
      [...files].sort(([left], [right]) => compareRemoteModulePaths(left, right)),
    );
    const decoded = await this.#codec.decode(stableFiles);
    const data = this.#codec.migration
      ? decoded
      : this.#codec.validate(decoded);

    return {
      ...toRemoteRevisionSnapshot(head.revision, head.snapshot.commitSha),
      data: data as T,
      files: stableFiles,
    };
  }

  async push(data: T, options: RemoteModulePushOptions): Promise<RemoteModulePushResult> {
    validateRevisionToken(options.expectedRevision, "expectedRevision", true);
    validateRevisionToken(options.nextRevision, "nextRevision", false);
    validateRemoteSchemaVersion(options.schemaVersion);

    const encoded = await this.#codec.encode(data);
    const desiredFiles = validateEncodedFiles(encoded);
    const updatedAt = options.updatedAt ?? this.#now().toISOString();

    if (!isIsoDate(updatedAt)) {
      throw new TypeError("updatedAt must be a valid ISO-8601 date string.");
    }

    const nextRevision: RemoteModuleRevision = {
      revision: options.nextRevision,
      updatedAt,
      schemaVersion: options.schemaVersion ?? null,
      managedFiles: [...desiredFiles.keys()].sort(compareRemoteModulePaths),
    };

    for (let retryCount = 0; retryCount <= this.#maxRefRetries; retryCount += 1) {
      const head = await this.#loadHead();
      const actualRevision = head.revision?.revision ?? null;

      if (actualRevision === options.nextRevision) {
        return {
          ...toRemoteRevisionSnapshot(
            head.revision as RemoteModuleRevision,
            head.snapshot.commitSha,
          ),
          status: "already-committed",
        };
      }

      if (actualRevision !== options.expectedRevision) {
        throw new RemoteModuleConflictError(
          options.expectedRevision,
          actualRevision,
          head.revision?.updatedAt ?? null,
        );
      }

      this.#assertUnknownFilesArePreserved(head, desiredFiles, head.revision?.managedFiles ?? []);
      const treeEntries = await this.#createTreeEntries(head, desiredFiles, nextRevision);
      const treeSha = await this.#client.createTree(head.snapshot.treeSha, treeEntries);
      const commitSha = await this.#client.createCommit(
        options.message ?? `Update ${this.moduleId} to ${options.nextRevision}`,
        treeSha,
        head.snapshot.commitSha,
      );

      try {
        await this.#client.updateBranchHead(commitSha);
        return {
          ...toRemoteRevisionSnapshot(nextRevision, commitSha),
          status: "committed",
        };
      } catch (error) {
        if (!isPotentialRefRace(error)) {
          throw error;
        }

        const resolved = await this.#resolveRefUpdateFailure(options, retryCount, error);
        if (resolved) {
          return resolved;
        }
      }
    }

    // The loop either returns or #resolveRefUpdateFailure throws at its retry limit.
    throw new GitHubRefUpdateRaceError(this.#maxRefRetries);
  }

  /** Explicit local-wins operation. It snapshots the current cloud revision, then performs a normal CAS push. */
  async overwrite(data: T, options: RemoteModuleOverwriteOptions): Promise<RemoteModulePushResult> {
    const current = await this.readRevision();
    return this.push(data, {
      ...options,
      expectedRevision: current?.revision ?? null,
    });
  }

  async #resolveRefUpdateFailure(
    options: RemoteModulePushOptions,
    retryCount: number,
    originalError: unknown,
  ): Promise<RemoteModulePushResult | null> {
    let latest: LoadedHead;

    try {
      latest = await this.#loadHead();
    } catch {
      throw originalError;
    }

    const actualRevision = latest.revision?.revision ?? null;

    if (actualRevision === options.nextRevision) {
      return {
        ...toRemoteRevisionSnapshot(
          latest.revision as RemoteModuleRevision,
          latest.snapshot.commitSha,
        ),
        status: "already-committed",
      };
    }

    if (actualRevision !== options.expectedRevision) {
      throw new RemoteModuleConflictError(
        options.expectedRevision,
        actualRevision,
        latest.revision?.updatedAt ?? null,
      );
    }

    if (retryCount >= this.#maxRefRetries) {
      throw new GitHubRefUpdateRaceError(this.#maxRefRetries);
    }

    return null;
  }

  async #createTreeEntries(
    head: LoadedHead,
    desiredFiles: ReadonlyMap<string, string>,
    revision: RemoteModuleRevision,
  ): Promise<GitHubCreateTreeEntry[]> {
    const blobEntries = await Promise.all(
      [...desiredFiles].map(async ([relativePath, text]): Promise<GitHubCreateTreeEntry> => ({
        path: this.#fullPath(relativePath),
        mode: "100644",
        type: "blob",
        sha: await this.#client.createBlob(text),
      })),
    );
    const revisionText = serializeRemoteModuleManifest(revision);
    const revisionBlobSha = await this.#client.createBlob(revisionText);
    const desiredPaths = new Set(desiredFiles.keys());
    const deletedEntries: GitHubCreateTreeEntry[] = (head.revision?.managedFiles ?? [])
      .filter((path) => !desiredPaths.has(path))
      .map((path) => ({
        path: this.#fullPath(path),
        mode: "100644",
        type: "blob",
        sha: null,
      }));

    const revisionEntry: GitHubCreateTreeEntry = {
      path: this.#revisionPath(),
      mode: "100644",
      type: "blob",
      sha: revisionBlobSha,
    };

    return [
      ...blobEntries,
      ...deletedEntries,
      revisionEntry,
    ].sort((left, right) => compareRemoteModulePaths(left.path, right.path));
  }

  #assertUnknownFilesArePreserved(
    head: LoadedHead,
    desiredFiles: ReadonlyMap<string, string>,
    oldManagedFiles: readonly string[],
  ): void {
    const oldManagedFullPaths = new Set(oldManagedFiles.map((path) => this.#fullPath(path)));
    const unknownPaths = [...head.blobByPath.keys()].filter(
      (path) => path.startsWith(`${this.moduleRoot}/`) &&
        path !== this.#revisionPath() &&
        !oldManagedFullPaths.has(path),
    );

    for (const desiredPath of desiredFiles.keys()) {
      const fullDesiredPath = this.#fullPath(desiredPath);
      const collision = unknownPaths.find(
        (unknownPath) => remoteModulePathsCollide(fullDesiredPath, unknownPath),
      );

      if (collision) {
        throw new RemoteModulePathError(
          `Managed path collides with an unknown remote file that must be preserved: ${desiredPath}`,
        );
      }
    }
  }

  async #loadHead(signal?: AbortSignal): Promise<LoadedHead> {
    const snapshot = await this.#client.getBranchSnapshot(signal);
    const blobByPath = new Map(
      snapshot.entries
        .filter((entry) => entry.type === "blob")
        .map((entry) => [entry.path, entry] as const),
    );
    const revisionEntry = blobByPath.get(this.#revisionPath());

    if (!revisionEntry) {
      return { snapshot, revision: null, blobByPath };
    }

    const revision = parseRemoteModuleManifest(
      await this.#client.readBlobText(revisionEntry.sha, signal),
    );

    for (const relativePath of revision.managedFiles) {
      if (!blobByPath.has(this.#fullPath(relativePath))) {
        throw new RemoteModuleFormatError(`Managed file is missing from the repository tree: ${relativePath}`);
      }
    }

    return { snapshot, revision, blobByPath };
  }

  #revisionPath(): string {
    return getRemoteModuleRevisionPath(this.moduleRoot);
  }

  #fullPath(relativePath: string): string {
    return getRemoteModuleFilePath(this.moduleRoot, relativePath);
  }
}

function isPotentialRefRace(error: unknown): boolean {
  return !(error instanceof GitHubApiError) || error.status === 409 || error.status === 422;
}
