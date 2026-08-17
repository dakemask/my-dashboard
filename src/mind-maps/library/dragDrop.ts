import type { LibrarySelection } from "./types";

type ConcreteSelection = Exclude<LibrarySelection, null>;

export interface LibraryDragDropCallbacks {
  readonly onMove: (selection: ConcreteSelection, destinationFolder: string) => void;
  readonly onToggleFolder: (path: string, expanded: boolean) => void;
  readonly isFolderExpanded: (path: string) => boolean;
}

/** Owns native HTML drag state, hover expansion timing, and visual cleanup. */
export class LibraryDragDrop {
  readonly #container: HTMLElement;
  readonly #rootDropTarget: HTMLElement;
  readonly #callbacks: LibraryDragDropCallbacks;
  readonly #window: Window;
  #dragged: ConcreteSelection | null = null;
  #hoverTimer: number | null = null;
  #hoverPath: string | null = null;

  constructor(
    container: HTMLElement,
    rootDropTarget: HTMLElement,
    callbacks: LibraryDragDropCallbacks,
  ) {
    const pageWindow = container.ownerDocument.defaultView;
    if (!pageWindow) throw new Error("Library drag and drop requires a browser window.");
    this.#window = pageWindow;
    this.#container = container;
    this.#rootDropTarget = rootDropTarget;
    this.#callbacks = callbacks;
    container.addEventListener("dragstart", this.#onDragStart);
    container.addEventListener("dragend", this.#onDragEnd);
    container.addEventListener("dragover", this.#onFolderDragOver);
    container.addEventListener("dragleave", this.#onFolderDragLeave);
    container.addEventListener("drop", this.#onFolderDrop);
    rootDropTarget.addEventListener("dragover", this.#onRootDragOver);
    rootDropTarget.addEventListener("dragleave", this.#onRootDragLeave);
    rootDropTarget.addEventListener("drop", this.#onRootDrop);
  }

  get dragging(): boolean {
    return this.#dragged !== null;
  }

  bindRow(row: HTMLElement, selection: ConcreteSelection): void {
    row.draggable = true;
    if (selection.kind === "folder") {
      row.dataset.dragKind = "folder";
      row.dataset.dragId = selection.path;
    } else {
      row.dataset.dragKind = "map";
      row.dataset.dragId = selection.mapId;
    }
  }

  bindFolderTarget(row: HTMLElement, path: string): void {
    row.dataset.folderDropPath = path;
  }

  cancel(): void {
    this.#dragged = null;
    this.#clearHoverTimer();
    this.#clearDropClasses();
  }

  dispose(): void {
    this.cancel();
    this.#container.removeEventListener("dragstart", this.#onDragStart);
    this.#container.removeEventListener("dragend", this.#onDragEnd);
    this.#container.removeEventListener("dragover", this.#onFolderDragOver);
    this.#container.removeEventListener("dragleave", this.#onFolderDragLeave);
    this.#container.removeEventListener("drop", this.#onFolderDrop);
    this.#rootDropTarget.removeEventListener("dragover", this.#onRootDragOver);
    this.#rootDropTarget.removeEventListener("dragleave", this.#onRootDragLeave);
    this.#rootDropTarget.removeEventListener("drop", this.#onRootDrop);
  }

  readonly #onDragStart = (event: DragEvent): void => {
    const row = this.#eventRow(event);
    if (!row) return;
    const selection = selectionFromRow(row);
    if (!selection) return;
    this.#dragged = selection;
    row.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", "mind-maps-library-entry");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };

  readonly #onDragEnd = (): void => this.cancel();

  readonly #onFolderDragOver = (event: DragEvent): void => {
    if (!this.#dragged) return;
    const row = this.#eventRow(event);
    const path = row?.dataset.folderDropPath;
    if (!path) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    row.classList.add("drop-target");
    if (!this.#callbacks.isFolderExpanded(path) && this.#hoverPath !== path) {
      this.#clearHoverTimer();
      this.#hoverPath = path;
      this.#hoverTimer = this.#window.setTimeout(() => {
        this.#hoverTimer = null;
        this.#hoverPath = null;
        this.#callbacks.onToggleFolder(path, true);
      }, 650);
    }
  };

  readonly #onFolderDragLeave = (event: DragEvent): void => {
    const row = this.#eventRow(event);
    if (!row) return;
    const NodeConstructor = row.ownerDocument.defaultView?.Node;
    if (NodeConstructor && event.relatedTarget instanceof NodeConstructor && row.contains(event.relatedTarget)) {
      return;
    }
    row.classList.remove("drop-target");
    const path = row.dataset.folderDropPath;
    if (path && this.#hoverPath === path) this.#clearHoverTimer();
  };

  readonly #onFolderDrop = (event: DragEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const row = this.#eventRow(event);
    const path = row?.dataset.folderDropPath;
    if (this.#dragged && path !== undefined) this.#callbacks.onMove(this.#dragged, path);
    this.cancel();
  };

  readonly #onRootDragOver = (event: DragEvent): void => {
    if (!this.#dragged) return;
    event.preventDefault();
    this.#rootDropTarget.classList.add("drop-target");
  };

  readonly #onRootDragLeave = (): void => {
    this.#rootDropTarget.classList.remove("drop-target");
  };

  readonly #onRootDrop = (event: DragEvent): void => {
    event.preventDefault();
    if (this.#dragged) this.#callbacks.onMove(this.#dragged, "");
    this.cancel();
  };

  #clearHoverTimer(): void {
    if (this.#hoverTimer !== null) this.#window.clearTimeout(this.#hoverTimer);
    this.#hoverTimer = null;
    this.#hoverPath = null;
  }

  #clearDropClasses(): void {
    this.#rootDropTarget.classList.remove("drop-target");
    for (const element of this.#container.querySelectorAll(".drop-target, .dragging")) {
      element.classList.remove("drop-target", "dragging");
    }
  }

  #eventRow(event: Event): HTMLElement | null {
    const ElementConstructor = this.#container.ownerDocument.defaultView?.Element;
    if (!ElementConstructor || !(event.target instanceof ElementConstructor)) return null;
    const row = event.target.closest<HTMLElement>(".library-row");
    return row && this.#container.contains(row) ? row : null;
  }
}

function selectionFromRow(row: HTMLElement): ConcreteSelection | null {
  const id = row.dataset.dragId;
  if (id === undefined) return null;
  return row.dataset.dragKind === "folder"
    ? { kind: "folder", path: id }
    : row.dataset.dragKind === "map" ? { kind: "map", mapId: id } : null;
}
