import type { ThoughtData, ThoughtNote } from "./types";

export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function createNote(content: string, tags: string[], now = new Date()): ThoughtNote {
  const timestamp = now.toISOString();

  return {
    id: crypto.randomUUID(),
    content,
    tags,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function addNote(data: ThoughtData, note: ThoughtNote): ThoughtData {
  return {
    notes: [note, ...data.notes],
  };
}

export function deleteNote(data: ThoughtData, id: string): ThoughtData {
  return {
    notes: data.notes.filter((note) => note.id !== id),
  };
}

export function getVisibleNotes(data: ThoughtData, query: string): ThoughtNote[] {
  const normalizedQuery = query.trim().toLowerCase();

  return [...data.notes]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((note) => {
      const text = `${note.content} ${note.tags.join(" ")}`.toLowerCase();
      return text.includes(normalizedQuery);
    });
}
