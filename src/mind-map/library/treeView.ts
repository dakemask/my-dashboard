import {
  Down,
  FolderClose,
  FolderOpen,
  MindmapMap,
} from "@icon-park/svg";
import type { MindMapPayload } from "../domain";
import { createMindMapIcon } from "../ui/icons";

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

interface FolderTreeNode {
  readonly path: string;
  readonly name: string;
  readonly folders: FolderTreeNode[];
  readonly maps: Array<{ readonly id: string; readonly path: string; readonly name: string }>;
}

export class LibraryTreeView {
  readonly #container: HTMLElement;
  readonly #rootDropTarget: HTMLElement;
  readonly #callbacks: LibraryTreeCallbacks;
  #state: LibraryTreeRenderState | null = null;
  #draft: LibraryDraft | null = null;
  #draftInput: HTMLInputElement | null = null;
  #draftError: HTMLElement | null = null;
  #dragged: Exclude<LibrarySelection, null> | null = null;
  #hoverTimer: number | null = null;
  #hoverPath: string | null = null;

  constructor(
    container: HTMLElement,
    rootDropTarget: HTMLElement,
    callbacks: LibraryTreeCallbacks,
  ) {
    this.#container = container;
    this.#rootDropTarget = rootDropTarget;
    this.#callbacks = callbacks;
    rootDropTarget.addEventListener("dragover", this.#onRootDragOver);
    rootDropTarget.addEventListener("dragleave", this.#onRootDragLeave);
    rootDropTarget.addEventListener("drop", this.#onRootDrop);
  }

  get draft(): LibraryDraft | null {
    return this.#draft;
  }

  get draftValue(): string | null {
    if (!this.#draft) return null;
    return this.#draftInput?.value ?? this.#draftInitialValue(this.#draft);
  }

  get dragging(): boolean {
    return this.#dragged !== null;
  }

  cancelLiveInteraction(): void {
    this.#dragged = null;
    this.#clearHoverTimer();
    this.#clearDropClasses();
  }

  focusSelection(selection: Exclude<LibrarySelection, null>): void {
    const rows = this.#container.querySelectorAll<HTMLButtonElement>(".library-row");
    const row = [...rows].find((candidate) => selection.kind === "folder"
      ? candidate.dataset.folderPath === selection.path
      : candidate.dataset.mapId === selection.mapId);
    row?.focus({ preventScroll: true });
  }

  /** Expands a hovered drop target without replacing the active native drag source. */
  expandFolderDuringDrag(path: string): boolean {
    const state = this.#state;
    if (!state || !this.#dragged || state.expandedFolders.has(path)) return false;
    const row = [...this.#container.querySelectorAll<HTMLButtonElement>(".library-row")]
      .find((candidate) => candidate.dataset.folderPath === path);
    const item = row?.closest<HTMLLIElement>(".library-folder");
    const folder = findFolder(buildTree(state.payload), path);
    if (!row || !item || !folder) return false;

    const expandedFolders = new Set(state.expandedFolders);
    expandedFolders.add(path);
    this.#state = { ...state, expandedFolders };
    item.setAttribute("aria-expanded", "true");
    const folderIcon = row.querySelector<HTMLElement>(".library-folder-icon");
    folderIcon?.replaceChildren(createMindMapIcon(this.#container.ownerDocument, FolderOpen));

    const children = this.#container.ownerDocument.createElement("ul");
    children.className = "library-level";
    children.setAttribute("role", "group");
    this.#appendDraftIfNeeded(children, folder.path);
    for (const child of folder.folders) children.append(this.#renderFolder(child));
    for (const map of folder.maps) children.append(this.#renderMap(map));
    item.append(children);
    return true;
  }

  render(state: LibraryTreeRenderState): void {
    this.#state = state;
    const root = buildTree(state.payload);
    const list = this.#container.ownerDocument.createElement("ul");
    list.className = "library-level library-level-root";
    list.setAttribute("role", "group");
    this.#appendDraftIfNeeded(list, "");
    for (const folder of root.folders) list.append(this.#renderFolder(folder));
    for (const map of root.maps) list.append(this.#renderMap(map));
    if (root.folders.length === 0 && root.maps.length === 0 && !this.#draft) {
      const empty = this.#container.ownerDocument.createElement("div");
      empty.className = "library-empty";
      const icon = this.#container.ownerDocument.createElement("span");
      icon.className = "library-empty-icon";
      icon.append(createMindMapIcon(this.#container.ownerDocument, MindmapMap));
      const title = this.#container.ownerDocument.createElement("strong");
      title.textContent = "资料库还是空的";
      const message = this.#container.ownerDocument.createElement("p");
      message.textContent = "新建一张脑图，开始整理想法。";
      empty.append(icon, title, message);
      this.#container.replaceChildren(empty);
    } else {
      this.#container.replaceChildren(list);
    }
    this.#focusDraft();
  }

  beginCreate(kind: "folder" | "map", parentPath: string): void {
    this.cancelDraft();
    this.#draft = {
      kind: kind === "folder" ? "new-folder" : "new-map",
      parentPath,
    };
    this.#rerender();
  }

  beginRename(selection: Exclude<LibrarySelection, null>): void {
    this.cancelDraft();
    this.#draft = { kind: "rename", selection };
    this.#rerender();
  }

  /** Commits a valid draft. Invalid drafts are either retained or explicitly cancelled. */
  settleDraft(cancelInvalid: boolean): boolean {
    if (!this.#draft) return true;
    const value = this.#draftInput?.value ?? this.#draftInitialValue(this.#draft);
    const validation = this.#callbacks.validateDraft(this.#draft, value);
    if (validation) {
      if (cancelInvalid) {
        this.cancelDraft();
        return true;
      }
      this.#showDraftError(validation);
      return false;
    }
    return this.#commitDraft(value);
  }

  /**
   * Removes a draft for a Shared settle hook without dispatching from inside
   * the already-running runtime command. The controller converts the result
   * into the one event returned to Shared.
   */
  takeDraftForSettle(cancelInvalid: boolean): SettledLibraryDraft | null {
    const draft = this.#draft;
    if (!draft) return null;
    const value = this.#draftInput?.value ?? this.#draftInitialValue(draft);
    const validation = this.#callbacks.validateDraft(draft, value);
    if (validation) {
      if (!cancelInvalid) {
        this.#showDraftError(validation);
        return null;
      }
      this.cancelDraft();
      return null;
    }
    this.#draft = null;
    this.#draftInput = null;
    this.#draftError = null;
    this.#rerender();
    return { draft, value };
  }

  cancelDraft(): void {
    if (!this.#draft) return;
    this.#draft = null;
    this.#draftInput = null;
    this.#draftError = null;
    this.#callbacks.onDraftCancelled?.();
    this.#rerender();
  }

  dispose(): void {
    this.cancelLiveInteraction();
    this.#rootDropTarget.removeEventListener("dragover", this.#onRootDragOver);
    this.#rootDropTarget.removeEventListener("dragleave", this.#onRootDragLeave);
    this.#rootDropTarget.removeEventListener("drop", this.#onRootDrop);
  }

  #renderFolder(folder: FolderTreeNode): HTMLLIElement {
    const state = this.#state!;
    const item = this.#container.ownerDocument.createElement("li");
    item.className = "library-item library-folder";
    item.setAttribute("role", "treeitem");
    const expanded = state.expandedFolders.has(folder.path);
    item.setAttribute("aria-expanded", String(expanded));

    if (
      this.#draft?.kind === "rename"
      && this.#draft.selection.kind === "folder"
      && this.#draft.selection.path === folder.path
    ) {
      item.append(this.#createDraftEditor(this.#draft, folder.name, expanded));
      if (expanded) {
        const children = this.#container.ownerDocument.createElement("ul");
        children.className = "library-level";
        children.setAttribute("role", "group");
        for (const child of folder.folders) children.append(this.#renderFolder(child));
        for (const map of folder.maps) children.append(this.#renderMap(map));
        item.append(children);
      }
      return item;
    }

    const row = this.#createRow({ kind: "folder", path: folder.path });
    row.dataset.folderPath = folder.path;
    row.classList.toggle(
      "selected",
      state.selection?.kind === "folder" && state.selection.path === folder.path,
    );
    row.classList.toggle("dirty", state.dirtyFolderPaths.has(folder.path));
    row.addEventListener("click", () => {
      this.#callbacks.onSelect({ kind: "folder", path: folder.path });
      this.#callbacks.onToggleFolder(folder.path, !expanded);
    });
    row.addEventListener("dragover", (event) => this.#onFolderDragOver(event, folder.path));
    row.addEventListener("dragleave", (event) => this.#onFolderDragLeave(event, folder.path));
    row.addEventListener("drop", (event) => this.#onFolderDrop(event, folder.path));

    const arrow = this.#container.ownerDocument.createElement("span");
    arrow.className = "folder-arrow";
    arrow.append(createMindMapIcon(this.#container.ownerDocument, Down));
    const folderIcon = this.#container.ownerDocument.createElement("span");
    folderIcon.className = "library-item-icon library-folder-icon";
    folderIcon.append(
      createMindMapIcon(this.#container.ownerDocument, expanded ? FolderOpen : FolderClose),
    );
    const name = this.#container.ownerDocument.createElement("span");
    name.className = "library-item-name";
    name.textContent = folder.name;
    row.append(arrow, folderIcon, name);
    if (state.dirtyFolderPaths.has(folder.path)) {
      row.append(this.#createDirtyMarker());
      row.setAttribute("aria-label", `${folder.name}，有未保存修改`);
    }
    item.append(row);

    if (expanded) {
      const children = this.#container.ownerDocument.createElement("ul");
      children.className = "library-level";
      children.setAttribute("role", "group");
      this.#appendDraftIfNeeded(children, folder.path);
      for (const child of folder.folders) children.append(this.#renderFolder(child));
      for (const map of folder.maps) children.append(this.#renderMap(map));
      item.append(children);
    }
    return item;
  }

  #renderMap(map: { readonly id: string; readonly path: string; readonly name: string }): HTMLLIElement {
    const state = this.#state!;
    const item = this.#container.ownerDocument.createElement("li");
    item.className = "library-item library-map";
    item.setAttribute("role", "treeitem");
    const selection: Exclude<LibrarySelection, null> = { kind: "map", mapId: map.id };

    if (
      this.#draft?.kind === "rename"
      && this.#draft.selection.kind === "map"
      && this.#draft.selection.mapId === map.id
    ) {
      item.append(this.#createDraftEditor(this.#draft, map.name));
      return item;
    }

    const row = this.#createRow(selection);
    row.dataset.mapId = map.id;
    row.classList.toggle(
      "selected",
      state.selection?.kind === "map" && state.selection.mapId === map.id,
    );
    row.classList.toggle("current", state.currentMapId === map.id);
    row.classList.toggle("dirty", state.dirtyMapIds.has(map.id));
    row.addEventListener("click", () => {
      this.#callbacks.onSelect(selection);
      this.#callbacks.onOpenMap(map.id);
    });
    const spacer = this.#container.ownerDocument.createElement("span");
    spacer.className = "folder-arrow folder-arrow-spacer";
    const icon = this.#container.ownerDocument.createElement("span");
    icon.className = "library-item-icon map-icon";
    icon.append(createMindMapIcon(this.#container.ownerDocument, MindmapMap));
    const name = this.#container.ownerDocument.createElement("span");
    name.className = "library-item-name";
    name.textContent = map.name;
    row.append(spacer, icon, name);
    if (state.dirtyMapIds.has(map.id)) {
      row.append(this.#createDirtyMarker());
      row.setAttribute("aria-label", `${map.name}，有未保存修改`);
    }
    item.append(row);
    return item;
  }

  #createRow(selection: Exclude<LibrarySelection, null>): HTMLButtonElement {
    const row = this.#container.ownerDocument.createElement("button");
    row.type = "button";
    row.className = "library-row";
    row.draggable = true;
    row.addEventListener("dragstart", (event) => {
      this.#dragged = selection;
      row.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", "mind-map-library-entry");
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      this.#dragged = null;
      this.#clearHoverTimer();
      this.#clearDropClasses();
    });
    return row;
  }

  #appendDraftIfNeeded(list: HTMLUListElement, parentPath: string): void {
    const draft = this.#draft;
    if (!draft || draft.kind === "rename" || draft.parentPath !== parentPath) return;
    const item = this.#container.ownerDocument.createElement("li");
    item.className = "library-item library-draft-item";
    item.append(this.#createDraftEditor(draft, ""));
    list.append(item);
  }

  #createDraftEditor(
    draft: LibraryDraft,
    value: string,
    folderExpanded = false,
  ): HTMLElement {
    const editor = this.#container.ownerDocument.createElement("div");
    editor.className = "library-inline-editor";
    editor.classList.toggle("is-rename", draft.kind === "rename");
    const spacer = this.#container.ownerDocument.createElement("span");
    spacer.className = "folder-arrow folder-arrow-spacer";
    const icon = this.#container.ownerDocument.createElement("span");
    icon.className = "library-item-icon";
    const isFolder = draft.kind === "new-folder"
      || (draft.kind === "rename" && draft.selection.kind === "folder");
    if (isFolder && draft.kind === "rename") {
      spacer.append(createMindMapIcon(this.#container.ownerDocument, Down));
    }
    icon.classList.toggle("library-folder-icon", isFolder);
    icon.classList.toggle("map-icon", !isFolder);
    icon.append(createMindMapIcon(
      this.#container.ownerDocument,
      isFolder ? (folderExpanded ? FolderOpen : FolderClose) : MindmapMap,
    ));
    const input = this.#container.ownerDocument.createElement("input");
    input.type = "text";
    input.value = value;
    input.setAttribute("aria-label", draft.kind === "rename" ? "新名称" : "项目名称");
    const cancel = this.#container.ownerDocument.createElement("button");
    cancel.type = "button";
    cancel.className = "inline-cancel";
    cancel.hidden = true;
    cancel.addEventListener("click", () => this.cancelDraft());
    const error = this.#container.ownerDocument.createElement("span");
    error.className = "inline-error";
    error.setAttribute("role", "alert");
    input.addEventListener("input", () => {
      error.textContent = "";
      input.removeAttribute("aria-invalid");
    });
    input.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape"
        && !event.ctrlKey
        && !event.altKey
        && !event.metaKey
        && !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.cancelDraft();
        return;
      }
      if (
        event.key !== "Enter"
        || event.isComposing
        || event.keyCode === 229
        || event.ctrlKey
        || event.altKey
        || event.metaKey
        || event.shiftKey
      ) return;
      event.preventDefault();
      this.#attemptDraftCommit();
    });
    input.addEventListener("blur", () => this.#attemptDraftCommit());
    editor.append(spacer, icon, input, cancel, error);
    this.#draftInput = input;
    this.#draftError = error;
    return editor;
  }

  #attemptDraftCommit(): void {
    if (!this.#draft || !this.#draftInput) return;
    const validation = this.#callbacks.validateDraft(this.#draft, this.#draftInput.value);
    if (validation) {
      this.#showDraftError(validation);
      queueMicrotask(() => this.#draftInput?.focus());
      return;
    }
    this.#commitDraft(this.#draftInput.value);
  }

  #commitDraft(value: string): boolean {
    const draft = this.#draft;
    if (!draft) return true;
    const error = this.#callbacks.commitDraft(draft, value);
    if (error) {
      this.#showDraftError(error);
      queueMicrotask(() => this.#draftInput?.focus());
      return false;
    }
    this.#draft = null;
    this.#draftInput = null;
    this.#draftError = null;
    this.#rerender();
    return true;
  }

  #showDraftError(message: string): void {
    if (this.#draftError) this.#draftError.textContent = message;
    this.#draftInput?.setAttribute("aria-invalid", "true");
  }

  #createDirtyMarker(): HTMLElement {
    const marker = this.#container.ownerDocument.createElement("span");
    marker.className = "library-dirty-marker";
    marker.textContent = "*";
    marker.title = "有未保存修改";
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }

  #draftInitialValue(draft: LibraryDraft): string {
    if (draft.kind !== "rename" || !this.#state) return "";
    if (draft.selection.kind === "folder") return basename(draft.selection.path);
    const mapId = draft.selection.mapId;
    return this.#state.payload.maps.find((map) => map.id === mapId)?.path
      .split("/")
      .at(-1) ?? "";
  }

  #focusDraft(): void {
    const draft = this.#draft;
    if (!draft || !this.#draftInput) return;
    if (draft.kind === "rename" && this.#draftInput.value.length === 0) {
      this.#draftInput.value = this.#draftInitialValue(draft);
    }
    queueMicrotask(() => {
      this.#draftInput?.focus();
      this.#draftInput?.select();
    });
  }

  #rerender(): void {
    if (this.#state) this.render(this.#state);
  }

  #onFolderDragOver(event: DragEvent, path: string): void {
    if (!this.#dragged) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    (event.currentTarget as HTMLElement).classList.add("drop-target");
    if (!this.#state?.expandedFolders.has(path) && this.#hoverPath !== path) {
      this.#clearHoverTimer();
      this.#hoverPath = path;
      this.#hoverTimer = window.setTimeout(() => {
        this.#hoverTimer = null;
        this.#hoverPath = null;
        this.#callbacks.onToggleFolder(path, true);
      }, 650);
    }
  }

  #onFolderDragLeave(event: DragEvent, path: string): void {
    const row = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
    row.classList.remove("drop-target");
    if (this.#hoverPath === path) this.#clearHoverTimer();
  }

  #onFolderDrop(event: DragEvent, path: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.#dragged) this.#callbacks.onMove(this.#dragged, path);
    this.#dragged = null;
    this.#clearHoverTimer();
    this.#clearDropClasses();
  }

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
    this.#dragged = null;
    this.#clearHoverTimer();
    this.#clearDropClasses();
  };

  #clearHoverTimer(): void {
    if (this.#hoverTimer !== null) window.clearTimeout(this.#hoverTimer);
    this.#hoverTimer = null;
    this.#hoverPath = null;
  }

  #clearDropClasses(): void {
    this.#rootDropTarget.classList.remove("drop-target");
    for (const element of this.#container.querySelectorAll(".drop-target, .dragging")) {
      element.classList.remove("drop-target", "dragging");
    }
  }
}

function buildTree(payload: MindMapPayload): FolderTreeNode {
  const root: MutableFolder = { path: "", name: "", folders: [], maps: [] };
  const byPath = new Map<string, MutableFolder>([["", root]]);
  for (const path of [...payload.folders].sort(comparePath)) {
    const parentPath = dirname(path);
    const folder: MutableFolder = { path, name: basename(path), folders: [], maps: [] };
    byPath.set(path, folder);
    byPath.get(parentPath)?.folders.push(folder);
  }
  for (const map of payload.maps) {
    byPath.get(dirname(map.path))?.maps.push({ id: map.id, path: map.path, name: basename(map.path) });
  }
  sortFolder(root);
  return root;
}

function findFolder(root: FolderTreeNode, path: string): FolderTreeNode | null {
  for (const folder of root.folders) {
    if (folder.path === path) return folder;
    const nested = findFolder(folder, path);
    if (nested) return nested;
  }
  return null;
}

interface MutableFolder {
  path: string;
  name: string;
  folders: MutableFolder[];
  maps: Array<{ id: string; path: string; name: string }>;
}

function sortFolder(folder: MutableFolder): void {
  const compare = (a: { name: string }, b: { name: string }): number =>
    a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base", numeric: true });
  folder.folders.sort(compare);
  folder.maps.sort(compare);
  for (const child of folder.folders) sortFolder(child);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function comparePath(a: string, b: string): number {
  const depth = (path: string): number => path.split("/").length;
  return depth(a) - depth(b) || a.localeCompare(b);
}
