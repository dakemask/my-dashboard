export interface DashboardRepositoryConfig {
  readonly repository: string;
  readonly branch: string;
}

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";

export const DASHBOARD_REPOSITORY_CONFIG = {
  repository: "my-dashboard-data",
  branch: "main",
} as const satisfies DashboardRepositoryConfig;
