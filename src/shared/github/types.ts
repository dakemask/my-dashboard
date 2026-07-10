export const GITHUB_DATA_REPOSITORY = "my-dashboard-data";
export const GITHUB_DATA_BRANCH = "main";
export const GITHUB_API_VERSION = "2022-11-28";
export const MODULE_REVISION_FILE = "revision.json";

export type GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GitHubGitDataClientOptions {
  owner: string;
  token: string;
  fetch: GitHubFetch;
  /** Called only when GitHub explicitly rejects the credential with HTTP 401. */
  onCredentialsInvalid: () => void;
}

export interface GitHubRepositoryCoordinates {
  owner: string;
  repository: string;
  branch: string;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GitHubTreeSnapshot {
  commitSha: string;
  treeSha: string;
  entries: readonly GitHubTreeEntry[];
}

export interface GitHubCreateTreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
}

export interface RemoteModuleCodec<T> {
  moduleId: string;
  encode(data: T): ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>;
  decode(files: ReadonlyMap<string, string>): T | Promise<T>;
}

export interface RemoteModuleRevision {
  revision: string;
  updatedAt: string;
  managedFiles: readonly string[];
}

export interface RemoteRevisionSnapshot extends RemoteModuleRevision {
  commitSha: string;
}

export interface RemoteModuleSnapshot<T> extends RemoteRevisionSnapshot {
  data: T;
  files: ReadonlyMap<string, string>;
}

export interface RemoteModulePushOptions {
  expectedRevision: string | null;
  nextRevision: string;
  updatedAt?: string;
  message?: string;
}

export interface RemoteModuleOverwriteOptions {
  nextRevision: string;
  updatedAt?: string;
  message?: string;
}

export interface RemoteModulePushResult extends RemoteRevisionSnapshot {
  status: "committed" | "already-committed";
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class RemoteModuleConflictError extends Error {
  constructor(
    readonly expectedRevision: string | null,
    readonly actualRevision: string | null,
  ) {
    super("The remote module changed since the expected revision.");
    this.name = "RemoteModuleConflictError";
  }
}

export class RemoteModuleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteModuleFormatError";
  }
}

export class RemoteModulePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteModulePathError";
  }
}

export class GitHubRefUpdateRaceError extends Error {
  constructor(readonly retryCount: number) {
    super(`The GitHub branch head kept changing after ${retryCount} retries.`);
    this.name = "GitHubRefUpdateRaceError";
  }
}
