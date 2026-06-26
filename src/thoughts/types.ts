export interface ThoughtNote {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ThoughtData {
  notes: ThoughtNote[];
}

export interface ThoughtState {
  sha: string | null;
  data: ThoughtData;
}
