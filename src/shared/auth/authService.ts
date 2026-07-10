import { DASHBOARD_REPOSITORY_CONFIG, type DashboardRepositoryConfig } from "../config";
import { createCredentialsStore, type CredentialsStore } from "./credentialsStore";
import {
  AuthenticationError,
  type AuthSession,
  type AuthState,
  type GitHubCredentials,
  type GitHubRepositoryResponse,
  type GitHubUserResponse,
} from "./types";

export interface AuthService {
  getState(): AuthState;
  restore(): AuthSession | null;
  login(credentials: GitHubCredentials): Promise<AuthSession>;
  invalidate(): void;
  subscribe(listener: (state: AuthState) => void): () => void;
}

interface AuthServiceOptions {
  credentialsStore?: CredentialsStore;
  fetch?: typeof fetch;
}

export function createAuthService(options: AuthServiceOptions = {}): AuthService {
  const repository = DASHBOARD_REPOSITORY_CONFIG;
  const credentialsStore = options.credentialsStore ?? createCredentialsStore();
  const request = options.fetch ?? fetch;
  const listeners = new Set<(state: AuthState) => void>();
  let state: AuthState = { status: "anonymous" };

  const publish = (nextState: AuthState): void => {
    state = nextState;
    listeners.forEach((listener) => listener(state));
  };

  return {
    getState: () => state,

    restore(): AuthSession | null {
      const credentials = credentialsStore.load();
      if (!credentials) {
        publish({ status: "anonymous" });
        return null;
      }

      const session = createSession(credentials, repository);
      publish({ status: "authenticated", session });
      return session;
    },

    async login(credentials: GitHubCredentials): Promise<AuthSession> {
      const normalized = {
        username: credentials.username.trim(),
        token: credentials.token.trim(),
      };

      if (!normalized.username || !normalized.token) {
        throw new AuthenticationError("请输入 GitHub 用户名和 token。");
      }

      await validateCredentials(normalized, repository, request);
      credentialsStore.save(normalized);
      const session = createSession(normalized, repository);
      publish({ status: "authenticated", session });
      return session;
    },

    invalidate(): void {
      credentialsStore.clear();
      publish({ status: "anonymous" });
    },

    subscribe(listener: (nextState: AuthState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function validateCredentials(
  credentials: GitHubCredentials,
  repository: DashboardRepositoryConfig,
  request: typeof fetch,
): Promise<void> {
  const headers = createHeaders(credentials.token);
  const user = await githubRequest<GitHubUserResponse>(request, "https://api.github.com/user", headers);

  if (user.login.toLowerCase() !== credentials.username.toLowerCase()) {
    throw new AuthenticationError("GitHub 用户名与 token 所属账号不一致。");
  }

  const repositoryUrl = `https://api.github.com/repos/${encodeURIComponent(credentials.username)}/${encodeURIComponent(repository.repository)}`;
  const repo = await githubRequest<GitHubRepositoryResponse>(request, repositoryUrl, headers);

  if (repo.owner?.login?.toLowerCase() !== credentials.username.toLowerCase()) {
    throw new AuthenticationError("数据仓库不属于当前 GitHub 用户。");
  }

  if (!repo.private) {
    throw new AuthenticationError("数据仓库必须是私有仓库。");
  }

  if (!repo.permissions?.pull || !repo.permissions.push) {
    throw new AuthenticationError("token 没有数据仓库的读写权限。");
  }

  const branchUrl = `${repositoryUrl}/git/ref/heads/${encodeURIComponent(repository.branch)}`;
  await githubRequest<unknown>(request, branchUrl, headers);
}

async function githubRequest<T>(request: typeof fetch, url: string, headers: HeadersInit): Promise<T> {
  let response: Response;

  try {
    response = await request(url, { headers });
  } catch {
    throw new AuthenticationError("无法连接 GitHub，请检查网络后重试。");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError("GitHub 用户名、token 或仓库权限无效。", response.status);
    }

    if (response.status === 404) {
      throw new AuthenticationError("找不到固定的数据仓库或 main 分支。", response.status);
    }

    throw new AuthenticationError(`GitHub 验证失败（${response.status}）。`, response.status);
  }

  return response.json() as Promise<T>;
}

function createHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function createSession(credentials: GitHubCredentials, repository: DashboardRepositoryConfig): AuthSession {
  return {
    credentials,
    repository: {
      ...repository,
      owner: credentials.username,
    },
  };
}
