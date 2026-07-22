import { base64ToText } from "../base64";
import {
  GITHUB_API_VERSION,
  GITHUB_DATA_BRANCH,
  GITHUB_DATA_REPOSITORY,
  GitHubApiError,
  type GitHubCreateTreeEntry,
  type GitHubGitDataClientOptions,
  type GitHubRepositoryCoordinates,
  type GitHubTreeEntry,
  type GitHubTreeSnapshot,
} from "./types";

interface GitReferenceResponse {
  object: {
    sha: string;
  };
}

interface GitCommitResponse {
  sha: string;
  tree: {
    sha: string;
  };
}

interface GitTreeResponse {
  sha: string;
  truncated: boolean;
  tree: GitHubTreeEntry[];
}

interface GitBlobResponse {
  encoding: "base64";
  content: string;
}

interface GitObjectResponse {
  sha: string;
}

const GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * Minimal Git Data API client used by module persistence. `fetch` is mandatory so
 * tests and callers own all I/O; this module never falls back to global fetch.
 */
export class GitHubGitDataClient {
  readonly coordinates: GitHubRepositoryCoordinates;

  readonly #fetch: GitHubGitDataClientOptions["fetch"];
  readonly #token: string;
  readonly #onCredentialsInvalid: () => void;

  constructor(options: GitHubGitDataClientOptions) {
    const owner = options.owner.trim();
    const repository = GITHUB_DATA_REPOSITORY;
    const branch = GITHUB_DATA_BRANCH;

    if (!owner || !repository || !branch) {
      throw new TypeError("GitHub owner, repository, and branch must not be empty.");
    }

    if (!options.token) {
      throw new TypeError("GitHub token must not be empty.");
    }

    if (typeof options.fetch !== "function") {
      throw new TypeError("An injected fetch implementation is required.");
    }

    if (typeof options.onCredentialsInvalid !== "function") {
      throw new TypeError("An invalid-credentials callback is required.");
    }

    this.coordinates = Object.freeze({ owner, repository, branch });
    this.#fetch = options.fetch;
    this.#token = options.token;
    this.#onCredentialsInvalid = options.onCredentialsInvalid;
  }

  async getBranchSnapshot(signal?: AbortSignal): Promise<GitHubTreeSnapshot> {
    const reference = await this.#request<GitReferenceResponse>(
      "GET",
      `/git/ref/heads/${encodePath(this.coordinates.branch)}`,
      undefined,
      signal,
    );
    const commit = await this.getCommit(reference.object.sha, signal);
    const tree = await this.#request<GitTreeResponse>(
      "GET",
      `/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`,
      undefined,
      signal,
    );

    if (tree.truncated) {
      throw new GitHubApiError(
        "GitHub returned a truncated repository tree.",
        422,
        "GET",
        `/git/trees/${commit.tree.sha}`,
      );
    }

    return {
      commitSha: commit.sha,
      treeSha: tree.sha,
      entries: tree.tree.map((entry) => ({ ...entry })),
    };
  }

  getCommit(commitSha: string, signal?: AbortSignal): Promise<GitCommitResponse> {
    return this.#request("GET", `/git/commits/${encodeURIComponent(commitSha)}`, undefined, signal);
  }

  async readBlobText(blobSha: string, signal?: AbortSignal): Promise<string> {
    const blob = await this.#request<GitBlobResponse>(
      "GET",
      `/git/blobs/${encodeURIComponent(blobSha)}`,
      undefined,
      signal,
    );

    if (blob.encoding !== "base64" || typeof blob.content !== "string") {
      throw new GitHubApiError("GitHub returned an unsupported blob encoding.", 422, "GET", "/git/blobs/:sha");
    }

    return base64ToText(blob.content);
  }

  async createBlob(text: string): Promise<string> {
    const blob = await this.#request<GitObjectResponse>("POST", "/git/blobs", {
      content: text,
      encoding: "utf-8",
    });
    return blob.sha;
  }

  async createTree(baseTreeSha: string, entries: readonly GitHubCreateTreeEntry[]): Promise<string> {
    const tree = await this.#request<GitObjectResponse>("POST", "/git/trees", {
      base_tree: baseTreeSha,
      tree: entries,
    });
    return tree.sha;
  }

  async createCommit(message: string, treeSha: string, parentCommitSha: string): Promise<string> {
    const commit = await this.#request<GitObjectResponse>("POST", "/git/commits", {
      message,
      tree: treeSha,
      parents: [parentCommitSha],
    });
    return commit.sha;
  }

  async updateBranchHead(commitSha: string): Promise<void> {
    await this.#request<GitReferenceResponse>(
      "PATCH",
      `/git/refs/heads/${encodePath(this.coordinates.branch)}`,
      { sha: commitSha, force: false },
    );
  }

  async #request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${GITHUB_API_BASE_URL}${this.#repositoryPath()}${endpoint}`;
    const readsMutableBranchReference = method === "GET" && endpoint.startsWith("/git/ref/");
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.#token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.#fetch(url, {
      method,
      headers,
      signal,
      ...(readsMutableBranchReference ? { cache: "no-store" as const } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.#onCredentialsInvalid();
      }
      throw new GitHubApiError(
        safeGitHubErrorMessage(response.status),
        response.status,
        method,
        endpoint,
      );
    }

    return (await response.json()) as T;
  }

  #repositoryPath(): string {
    const { owner, repository } = this.coordinates;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function safeGitHubErrorMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "GitHub credentials are invalid or do not have the required repository permissions.";
  }

  if (status === 404) {
    return "The requested GitHub repository object was not found.";
  }

  if (status === 409 || status === 422) {
    return "GitHub rejected the repository update because its state changed or the request was invalid.";
  }

  return `GitHub API request failed with status ${status}.`;
}
