import { loadJsonFile, saveJsonFile } from "../shared/privateData/jsonFileRepository";
import type { LoadedJsonFile, PrivateDataSettings } from "../shared/privateData/types";
import type { ThoughtData, ThoughtNote } from "./types";

export async function loadThoughtData(
  settings: PrivateDataSettings,
): Promise<LoadedJsonFile<ThoughtData>> {
  return loadJsonFile(settings, normalizeThoughtData, createEmptyData);
}

export async function saveThoughtData(
  settings: PrivateDataSettings,
  data: ThoughtData,
  sha: string | null,
  message: string,
): Promise<string> {
  return saveJsonFile(settings, data, sha, message);
}

function normalizeThoughtData(value: unknown): ThoughtData {
  if (!value || typeof value !== "object" || !("notes" in value) || !Array.isArray(value.notes)) {
    return createEmptyData();
  }

  return {
    notes: value.notes.map(normalizeThoughtNote).filter((note): note is ThoughtNote => note !== null),
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
