import { GitHubApiError, readTextFile, updateTextFile } from "./githubContentApi";
import type { LoadedJsonFile, PrivateDataSettings } from "./types";

export async function loadJsonFile<T>(
  settings: PrivateDataSettings,
  normalize: (value: unknown) => T,
  createEmpty: () => T,
): Promise<LoadedJsonFile<T>> {
  try {
    const file = await readTextFile(settings);

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
  return updateTextFile(settings, {
    message,
    sha,
    text: JSON.stringify(data, null, 2),
  });
}
