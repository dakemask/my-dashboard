import { GitHubGitDataClient } from "./client";
import {
  GitHubApiError,
  GitHubRefUpdateRaceError,
  MODULE_REVISION_FILE,
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
const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

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
    this.moduleRoot = `data/${this.moduleId}`;
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
    return head.revision ? toRevisionSnapshot(head.revision, head.snapshot.commitSha) : null;
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

    const stableFiles = new Map([...files].sort(([left], [right]) => comparePaths(left, right)));
    const data = this.#codec.validate(await this.#codec.decode(stableFiles));

    return {
      ...toRevisionSnapshot(head.revision, head.snapshot.commitSha),
      data,
      files: stableFiles,
    };
  }

  async push(data: T, options: RemoteModulePushOptions): Promise<RemoteModulePushResult> {
    validateRevisionToken(options.expectedRevision, "expectedRevision", true);
    validateRevisionToken(options.nextRevision, "nextRevision", false);

    const encoded = await this.#codec.encode(data);
    const desiredFiles = validateEncodedFiles(encoded);
    const updatedAt = options.updatedAt ?? this.#now().toISOString();

    if (!isIsoDate(updatedAt)) {
      throw new TypeError("updatedAt must be a valid ISO-8601 date string.");
    }

    const nextRevision: RemoteModuleRevision = {
      revision: options.nextRevision,
      updatedAt,
      managedFiles: [...desiredFiles.keys()].sort(comparePaths),
    };

    for (let retryCount = 0; retryCount <= this.#maxRefRetries; retryCount += 1) {
      const head = await this.#loadHead();
      const actualRevision = head.revision?.revision ?? null;

      if (actualRevision === options.nextRevision) {
        return {
          ...toRevisionSnapshot(head.revision as RemoteModuleRevision, head.snapshot.commitSha),
          status: "already-committed",
        };
      }

      if (actualRevision !== options.expectedRevision) {
        throw new RemoteModuleConflictError(options.expectedRevision, actualRevision);
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
          ...toRevisionSnapshot(nextRevision, commitSha),
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
        ...toRevisionSnapshot(latest.revision as RemoteModuleRevision, latest.snapshot.commitSha),
        status: "already-committed",
      };
    }

    if (actualRevision !== options.expectedRevision) {
      throw new RemoteModuleConflictError(options.expectedRevision, actualRevision);
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
    const revisionText = `${JSON.stringify(revision, null, 2)}\n`;
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
    ].sort((left, right) => comparePaths(left.path, right.path));
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
      const collision = unknownPaths.find((unknownPath) => pathsCollide(fullDesiredPath, unknownPath));

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

    const revision = parseRemoteRevision(await this.#client.readBlobText(revisionEntry.sha, signal));
    validateManifestPaths(revision.managedFiles);

    for (const relativePath of revision.managedFiles) {
      if (!blobByPath.has(this.#fullPath(relativePath))) {
        throw new RemoteModuleFormatError(`Managed file is missing from the repository tree: ${relativePath}`);
      }
    }

    return { snapshot, revision, blobByPath };
  }

  #revisionPath(): string {
    return `${this.moduleRoot}/${MODULE_REVISION_FILE}`;
  }

  #fullPath(relativePath: string): string {
    return `${this.moduleRoot}/${relativePath}`;
  }
}

export function getModuleRoot(moduleId: string): string {
  return `data/${validateModuleId(moduleId)}`;
}

export function validateModuleId(moduleId: string): string {
  if (!MODULE_ID_PATTERN.test(moduleId)) {
    throw new RemoteModulePathError(
      "moduleId must contain lowercase ASCII letters or digits separated by single hyphens.",
    );
  }

  return moduleId;
}

function validateEncodedFiles(files: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  if (!(files instanceof Map) && typeof files?.entries !== "function") {
    throw new RemoteModulePathError("The module encoder must return a ReadonlyMap of text files.");
  }

  const result = new Map<string, string>();

  for (const [path, text] of files) {
    validateRelativePath(path);

    if (typeof text !== "string") {
      throw new RemoteModulePathError(`Managed file content must be text: ${path}`);
    }

    result.set(path, text);
  }

  validatePathCollisions([...result.keys()]);
  return result;
}

function validateManifestPaths(paths: readonly string[]): void {
  for (const path of paths) {
    validateRelativePath(path, RemoteModuleFormatError);
  }

  validatePathCollisions(paths, RemoteModuleFormatError);
  const sorted = [...paths].sort(comparePaths);

  if (paths.some((path, index) => path !== sorted[index])) {
    throw new RemoteModuleFormatError("revision.json managedFiles must be sorted.");
  }
}

function validateRelativePath(
  path: string,
  ErrorType: typeof RemoteModulePathError | typeof RemoteModuleFormatError = RemoteModulePathError,
): void {
  const invalid = typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((part) => part === "." || part === ".." || part.length === 0) ||
    path.toLocaleLowerCase("en-US") === MODULE_REVISION_FILE;

  if (invalid) {
    throw new ErrorType(`Invalid managed file path: ${String(path)}`);
  }
}

function validatePathCollisions(
  paths: readonly string[],
  ErrorType: typeof RemoteModulePathError | typeof RemoteModuleFormatError = RemoteModulePathError,
): void {
  const canonical = [...paths]
    .map((path) => ({ original: path, comparable: path.toLocaleLowerCase("en-US") }))
    .sort((left, right) => comparePaths(left.comparable, right.comparable));

  for (let index = 1; index < canonical.length; index += 1) {
    const previous = canonical[index - 1];
    const current = canonical[index];

    if (previous && current && pathsCollide(previous.comparable, current.comparable)) {
      throw new ErrorType(`Managed file paths collide: ${previous.original} and ${current.original}`);
    }
  }
}

function parseRemoteRevision(text: string): RemoteModuleRevision {
  let value: unknown;

  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new RemoteModuleFormatError("revision.json is not valid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteModuleFormatError("revision.json must contain an object.");
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.revision !== "string" ||
    record.revision.length === 0 ||
    typeof record.updatedAt !== "string" ||
    !isIsoDate(record.updatedAt) ||
    !Array.isArray(record.managedFiles) ||
    !record.managedFiles.every((path): path is string => typeof path === "string")
  ) {
    throw new RemoteModuleFormatError("revision.json has an invalid shape.");
  }

  return {
    revision: record.revision,
    updatedAt: record.updatedAt,
    managedFiles: [...record.managedFiles],
  };
}

function validateRevisionToken(value: string | null, name: string, nullable: boolean): void {
  if ((nullable && value === null) || (typeof value === "string" && value.length > 0)) {
    return;
  }

  throw new TypeError(`${name} must be ${nullable ? "null or " : ""}a non-empty string.`);
}

function isIsoDate(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isPotentialRefRace(error: unknown): boolean {
  return !(error instanceof GitHubApiError) || error.status === 409 || error.status === 422;
}

function pathsCollide(left: string, right: string): boolean {
  const canonicalLeft = left.toLocaleLowerCase("en-US");
  const canonicalRight = right.toLocaleLowerCase("en-US");
  return canonicalLeft === canonicalRight ||
    canonicalLeft.startsWith(`${canonicalRight}/`) ||
    canonicalRight.startsWith(`${canonicalLeft}/`);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toRevisionSnapshot(revision: RemoteModuleRevision, commitSha: string): RemoteRevisionSnapshot {
  return {
    revision: revision.revision,
    updatedAt: revision.updatedAt,
    managedFiles: [...revision.managedFiles],
    commitSha,
  };
}
