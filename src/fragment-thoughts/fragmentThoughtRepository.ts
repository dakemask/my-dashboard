import { loadJsonFile, saveJsonFile } from "../shared/privateData/jsonFileRepository";
import type { LoadedJsonFile, PrivateDataSettings } from "../shared/privateData/types";
import type { FragmentThought, FragmentThoughtData } from "./types";

export async function loadFragmentThoughtData(
  settings: PrivateDataSettings,
): Promise<LoadedJsonFile<FragmentThoughtData>> {
  return loadJsonFile(settings, normalizeFragmentThoughtData, createEmptyData);
}

export async function saveFragmentThoughtData(
  settings: PrivateDataSettings,
  data: FragmentThoughtData,
  sha: string | null,
  message: string,
): Promise<string> {
  return saveJsonFile(settings, data, sha, message);
}

function normalizeFragmentThoughtData(value: unknown): FragmentThoughtData {
  if (!value || typeof value !== "object" || !("notes" in value) || !Array.isArray(value.notes)) {
    return createEmptyData();
  }

  return {
    notes: value.notes
      .map(normalizeFragmentThought)
      .filter((fragmentThought): fragmentThought is FragmentThought => fragmentThought !== null),
  };
}

function normalizeFragmentThought(value: unknown): FragmentThought | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fragmentThought = value as Record<string, unknown>;

  if (
    typeof fragmentThought.id !== "string" ||
    typeof fragmentThought.content !== "string" ||
    typeof fragmentThought.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: fragmentThought.id,
    content: fragmentThought.content,
    tags: Array.isArray(fragmentThought.tags) ? fragmentThought.tags.filter((tag) => typeof tag === "string") : [],
    createdAt: fragmentThought.createdAt,
    updatedAt: typeof fragmentThought.updatedAt === "string" ? fragmentThought.updatedAt : fragmentThought.createdAt,
  };
}

function createEmptyData(): FragmentThoughtData {
  return {
    notes: [],
  };
}
