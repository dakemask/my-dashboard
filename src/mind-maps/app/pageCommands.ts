export type MindMapPageCommand =
  | "suppress-redo-shortcut"
  | "undo"
  | "redo"
  | "add-node"
  | "add-arrow"
  | "delete-library"
  | "delete-canvas";

export interface PageKeyCommandInput {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly textEditing: boolean;
  readonly withinLibrary: boolean;
  readonly hasLibrarySelection: boolean;
  readonly hasCanvasSelection: boolean;
}

/** Maps one keydown to at most one page command. */
export function routePageKeyCommand(input: PageKeyCommandInput): MindMapPageCommand | null {
  if (input.defaultPrevented) return null;
  const key = input.key.toLowerCase();
  const exactControl = input.ctrlKey && !input.altKey && !input.metaKey;
  if (exactControl && input.shiftKey && key === "z") return "suppress-redo-shortcut";
  if (exactControl && !input.shiftKey && key === "z") return "undo";
  if (exactControl && !input.shiftKey && key === "y") return "redo";

  const exactAlt = input.altKey && !input.ctrlKey && !input.metaKey && !input.shiftKey;
  if (exactAlt && input.key === "1") return "add-node";
  if (exactAlt && input.key === "2") return "add-arrow";

  const unmodifiedDelete = input.key === "Delete"
    && !input.ctrlKey
    && !input.altKey
    && !input.metaKey
    && !input.shiftKey;
  if (!unmodifiedDelete || input.textEditing) return null;
  if (input.withinLibrary && input.hasLibrarySelection) return "delete-library";
  if (input.hasCanvasSelection) return "delete-canvas";
  return null;
}
