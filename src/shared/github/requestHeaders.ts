import { GITHUB_API_VERSION } from "../config";

export function createGitHubRequestHeaders(
  token: string,
  hasJsonBody = false,
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
  };
}
