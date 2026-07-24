export interface FragmentThoughtVersion {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
}

export interface FragmentThought {
  readonly id: string;
  readonly versions: readonly FragmentThoughtVersion[];
  readonly collapsedVersionIds: readonly string[];
}

export interface FragmentThoughtsPayload {
  readonly schemaVersion: 2;
  readonly thoughts: readonly FragmentThought[];
}

export type FragmentThoughtsEvent =
  | { readonly type: "insert-thought"; readonly thought: FragmentThought }
  | { readonly type: "delete-thought"; readonly thoughtId: string }
  | {
      readonly type: "append-version";
      readonly thoughtId: string;
      readonly version: FragmentThoughtVersion;
      readonly collapsed: boolean;
    }
  | {
      readonly type: "remove-last-version";
      readonly thoughtId: string;
      readonly versionId: string;
    }
  | {
      readonly type: "set-version-collapsed";
      readonly thoughtId: string;
      readonly versionId: string;
      readonly collapsed: boolean;
    };
