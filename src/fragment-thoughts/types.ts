export interface FragmentThought {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FragmentThoughtData {
  notes: FragmentThought[];
}

export interface FragmentThoughtState {
  sha: string | null;
  data: FragmentThoughtData;
}
