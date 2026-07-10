export interface DashboardRepositoryConfig {
  readonly repository: string;
  readonly branch: string;
}

export const DASHBOARD_REPOSITORY_CONFIG: DashboardRepositoryConfig = {
  repository: "my-dashboard-data",
  branch: "main",
};
