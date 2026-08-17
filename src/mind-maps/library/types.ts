import type { MindMapPayload } from "../domain";

export type LibrarySelection =
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "map"; readonly mapId: string }
  | null;

export type LibraryDraft =
  | { readonly kind: "new-folder"; readonly parentPath: string }
  | { readonly kind: "new-map"; readonly parentPath: string }
  | { readonly kind: "rename"; readonly selection: Exclude<LibrarySelection, null> };

export interface LibraryTreeRenderState {
  readonly payload: MindMapPayload;
  readonly selection: LibrarySelection;
  readonly currentMapId: string | null;
  readonly expandedFolders: ReadonlySet<string>;
  readonly dirtyMapIds: ReadonlySet<string>;
  readonly dirtyFolderPaths: ReadonlySet<string>;
}

export interface LibraryTreeCallbacks {
  onSelect(selection: LibrarySelection): void;
  onOpenMap(mapId: string): void;
  onToggleFolder(path: string, expanded: boolean): void;
  onMove(selection: Exclude<LibrarySelection, null>, destinationFolder: string): void;
  validateDraft(draft: LibraryDraft, value: string): string | null;
  commitDraft(draft: LibraryDraft, value: string): string | null;
  onDraftCancelled?(): void;
}

export interface SettledLibraryDraft {
  readonly draft: LibraryDraft;
  readonly value: string;
}
