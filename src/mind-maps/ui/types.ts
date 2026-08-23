export interface MindMapShellElements {
  readonly root: HTMLElement;
  readonly homeButton: HTMLButtonElement;
  readonly sidebarButton: HTMLButtonElement;
  readonly mapTitle: HTMLElement;
  readonly syncMount: HTMLElement;
  readonly retrySaveButton: HTMLButtonElement;
  readonly addNodeButton: HTMLButtonElement;
  readonly addBracketButton: HTMLButtonElement;
  readonly addArrowButton: HTMLButtonElement;
  readonly resetViewButton: HTMLButtonElement;
  readonly sidebar: HTMLElement;
  readonly newFolderButton: HTMLButtonElement;
  readonly newMapButton: HTMLButtonElement;
  readonly renameButton: HTMLButtonElement;
  readonly deleteButton: HTMLButtonElement;
  readonly rootDropTarget: HTMLElement;
  readonly tree: HTMLElement;
  readonly canvasArea: HTMLElement;
  readonly canvasMount: HTMLElement;
  readonly canvasEmpty: HTMLElement;
  readonly toast: HTMLElement;
}

export interface DialogChoice {
  readonly id: string;
  readonly label: string;
  readonly tone?: "primary" | "danger" | "neutral";
}

export type MindMapMessageTone = "normal" | "success" | "error";
