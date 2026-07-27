import type { AuthSession, GitHubCredentials } from "../auth";

export interface DashboardAccount {
  readonly id: string;
  readonly username: string;
}

export interface StoredDashboardAccount extends DashboardAccount {
  readonly credentials: GitHubCredentials;
}

export type DashboardProfileContext =
  | {
      readonly mode: "local";
      readonly profileId: "local";
    }
  | {
      readonly mode: "account";
      readonly profileId: string;
      readonly account: DashboardAccount;
      readonly session: AuthSession;
    };

export interface DashboardProfileState {
  readonly mode: "local" | "accounts";
  readonly accounts: readonly DashboardAccount[];
  readonly activeAccountId: string | null;
}
