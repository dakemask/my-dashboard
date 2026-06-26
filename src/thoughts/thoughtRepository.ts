import { GitHubApiError, readFile, updateFile } from "./githubContentApi";
import type { ThoughtData, ThoughtNote, ThoughtSettings } from "./types";

export async function loadThoughtData(
  settings: ThoughtSettings,
): Promise<{ data: ThoughtData; sha: string | null; created: boolean }> {
  try {
    const file = await readFile(settings);

    return {
      data: normalizeThoughtData(JSON.parse(file.text)),
      sha: file.sha,
      created: false,
    };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return {
        data: createEmptyData(),
        sha: null,
        created: true,
      };
    }

    throw error;
  }
}

export async function saveThoughtData(
  settings: ThoughtSettings,
  data: ThoughtData,
  sha: string | null,
  message: string,
): Promise<string> {
  return updateFile(settings, {
    message,
    sha,
    text: JSON.stringify(data, null, 2),
  });
}

function normalizeThoughtData(value: unknown): ThoughtData {
  if (!value || typeof value !== "object" || !("notes" in value) || !Array.isArray(value.notes)) {
    return createEmptyData();
  }

  return {
    notes: value.notes.map(normalizeThoughtNote).filter((note) => note !== null),
  };
}

function normalizeThoughtNote(value: unknown): ThoughtNote | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const note = value as Record<string, unknown>;

  if (typeof note.id !== "string" || typeof note.content !== "string" || typeof note.createdAt !== "string") {
    return null;
  }

  return {
    id: note.id,
    content: note.content,
    tags: Array.isArray(note.tags) ? note.tags.filter((tag) => typeof tag === "string") : [],
    createdAt: note.createdAt,
    updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : note.createdAt,
  };
}

function createEmptyData(): ThoughtData {
  return {
    notes: [],
  };
}
