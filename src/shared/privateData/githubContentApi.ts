import { base64ToText, textToBase64 } from "../base64";
import type { PrivateDataSettings } from "./types";

interface GitHubContentResponse {
  sha: string;
  content: string;
  type: "file";
}

interface GitHubDirectoryItemResponse {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

interface GitHubUpdateResponse {
  content: {
    sha: string;
  };
}

interface UpdateTextFileInput {
  message: string;
  text: string;
  sha: string | null;
}

export interface GitHubDirectoryItem {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export function buildContentsUrl(settings: PrivateDataSettings): string {
  return buildContentsUrlForPath(settings, settings.path);
}

export function buildContentsUrlForPath(settings: PrivateDataSettings, filePath: string): string {
  const path = encodeURIComponent(trimSlashes(filePath)).replaceAll("%2F", "/");
  return `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${path}`;
}

export async function readTextFile(settings: PrivateDataSettings): Promise<{ sha: string; text: string }> {
  return readTextFileAtPath(settings, settings.path);
}

export async function readTextFileAtPath(
  settings: PrivateDataSettings,
  filePath: string,
): Promise<{ sha: string; text: string }> {
  const json = await githubFetch<GitHubContentResponse>(
    settings,
    `${buildContentsUrlForPath(settings, filePath)}?ref=${encodeURIComponent(settings.branch)}`,
  );

  return {
    sha: json.sha,
    text: base64ToText(json.content),
  };
}

export async function updateTextFile(settings: PrivateDataSettings, input: UpdateTextFileInput): Promise<string> {
  return updateTextFileAtPath(settings, settings.path, input);
}

export async function updateTextFileAtPath(
  settings: PrivateDataSettings,
  filePath: string,
  input: UpdateTextFileInput,
): Promise<string> {
  const body: {
    message: string;
    content: string;
    branch: string;
    sha?: string;
  } = {
    message: input.message,
    content: textToBase64(input.text),
    branch: settings.branch,
  };

  if (input.sha) {
    body.sha = input.sha;
  }

  const json = await githubFetch<GitHubUpdateResponse>(settings, buildContentsUrlForPath(settings, filePath), {
    method: "PUT",
    body: JSON.stringify(body),
  });

  return json.content.sha;
}

export async function deleteTextFileAtPath(
  settings: PrivateDataSettings,
  filePath: string,
  sha: string,
  message: string,
): Promise<void> {
  await githubFetch(settings, buildContentsUrlForPath(settings, filePath), {
    method: "DELETE",
    body: JSON.stringify({
      message,
      sha,
      branch: settings.branch,
    }),
  });
}

export async function listDirectoryAtPath(
  settings: PrivateDataSettings,
  directoryPath: string,
): Promise<GitHubDirectoryItem[]> {
  const json = await githubFetch<GitHubDirectoryItemResponse[] | GitHubContentResponse>(
    settings,
    `${buildContentsUrlForPath(settings, directoryPath)}?ref=${encodeURIComponent(settings.branch)}`,
  );

  if (!Array.isArray(json)) {
    throw new GitHubApiError("GitHub API 错误：指定路径是文件，不是文件夹。", 422);
  }

  return json.map((item) => ({
    name: item.name,
    path: item.path,
    sha: item.sha,
    type: item.type,
  }));
}

async function githubFetch<T>(
  settings: PrivateDataSettings,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${settings.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      throw new GitHubApiError(
        "GitHub Token 无效，或权限不够。请检查 token 是否只授权给数据仓库，并开启 Contents Read and write。",
        response.status,
      );
    }

    if (response.status === 409) {
      throw new GitHubApiError("保存冲突：其他浏览器可能刚保存过。请先点刷新，再保存。", response.status);
    }

    throw new GitHubApiError(`GitHub API 错误：${response.status} ${text}`, response.status);
  }

  return response.json() as Promise<T>;
}

function trimSlashes(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}
