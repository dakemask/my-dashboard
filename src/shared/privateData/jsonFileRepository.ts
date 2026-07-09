import { GitHubApiError, readTextFile, readTextFileAtPath, updateTextFile, updateTextFileAtPath } from "./githubContentApi";
import type { LoadedJsonFile, PrivateDataSettings } from "./types";

export async function loadJsonFile<T>(
  settings: PrivateDataSettings,
  normalize: (value: unknown) => T,
  createEmpty: () => T,
): Promise<LoadedJsonFile<T>> {
  return loadJsonFileAtPath(settings, settings.path, normalize, createEmpty);
}

export async function loadJsonFileAtPath<T>(
  settings: PrivateDataSettings,
  path: string,
  normalize: (value: unknown) => T,
  createEmpty: () => T,
): Promise<LoadedJsonFile<T>> {
  try {
    const file = path === settings.path ? await readTextFile(settings) : await readTextFileAtPath(settings, path);

    return {
      data: normalize(JSON.parse(file.text)),
      sha: file.sha,
      created: false,
    };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return {
        data: createEmpty(),
        sha: null,
        created: true,
      };
    }

    throw error;
  }
}

export function saveJsonFile<T>(
  settings: PrivateDataSettings,
  data: T,
  sha: string | null,
  message: string,
): Promise<string> {
  return saveJsonFileAtPath(settings, settings.path, data, sha, message);
}

export function saveJsonFileAtPath<T>(
  settings: PrivateDataSettings,
  path: string,
  data: T,
  sha: string | null,
  message: string,
): Promise<string> {
  const input = {
    message,
    sha,
    text: JSON.stringify(data, null, 2),
  };

  return path === settings.path ? updateTextFile(settings, input) : updateTextFileAtPath(settings, path, input);
}
