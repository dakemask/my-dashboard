import type { FragmentThought, FragmentThoughtData } from "./types";

export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function createFragmentThought(content: string, tags: string[], now = new Date()): FragmentThought {
  const timestamp = now.toISOString();

  return {
    id: crypto.randomUUID(),
    content,
    tags,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function addFragmentThought(
  data: FragmentThoughtData,
  fragmentThought: FragmentThought,
): FragmentThoughtData {
  return {
    notes: [fragmentThought, ...data.notes],
  };
}

export function deleteFragmentThought(data: FragmentThoughtData, id: string): FragmentThoughtData {
  return {
    notes: data.notes.filter((fragmentThought) => fragmentThought.id !== id),
  };
}

export function getVisibleFragmentThoughts(data: FragmentThoughtData, query: string): FragmentThought[] {
  const normalizedQuery = query.trim().toLowerCase();

  return [...data.notes]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((fragmentThought) => {
      const text = `${fragmentThought.content} ${fragmentThought.tags.join(" ")}`.toLowerCase();
      return text.includes(normalizedQuery);
    });
}
