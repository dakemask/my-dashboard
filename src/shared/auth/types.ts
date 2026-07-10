import type { DashboardRepositoryConfig } from "../config";

export interface GitHubCredentials {
  username: string;
  token: string;
}

export interface AuthSession {
  credentials: GitHubCredentials;
  repository: DashboardRepositoryConfig & { owner: string };
}

export interface GitHubUserResponse {
  login: string;
}

export interface GitHubRepositoryResponse {
  private: boolean;
  owner?: {
    login?: string;
  };
  permissions?: {
    pull?: boolean;
    push?: boolean;
  };
}

export type AuthState =
  | { status: "anonymous" }
  | { status: "authenticated"; session: AuthSession };

export class AuthenticationError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "AuthenticationError";
  }
}
