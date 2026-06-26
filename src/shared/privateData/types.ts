export interface PrivateDataSettings {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
}

export interface LoadedJsonFile<T> {
  data: T;
  sha: string | null;
  created: boolean;
}
