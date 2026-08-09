import { MindmapMap } from "@icon-park/svg";
import { createIconParkIcon } from "../../shared";
import { LibraryDragDrop } from "./dragDrop";
import {
  LibraryInlineEditor,
  type LibraryInlineEditorState,
} from "./inlineEditor";
import {
  createLibraryRowChrome,
  updateLibraryRowChrome,
  type LibraryRowChrome,
} from "./rowChrome";
import {
  buildLibraryTree,
  draftInitialValue,
  findFolderNode,
  sameLibraryDraft,
  sameLibrarySelection,
  type FolderTreeNode,
  type LibraryMapNode,
} from "./treeModel";
import type {
  LibraryDraft,
  LibrarySelection,
  LibraryTreeCallbacks,
  LibraryTreeRenderState,
  SettledLibraryDraft,
} from "./types";

export type {
  LibraryDraft,
  LibrarySelection,
  LibraryTreeCallbacks,
  LibraryTreeRenderState,
  SettledLibraryDraft,
} from "./types";

type ConcreteSelection = Exclude<LibrarySelection, null>;

/**
 * Compatibility facade for the library tree. Domain modelling, inline editing,
 * and native drag/drop state live in focused collaborators behind this class.
 */
export class LibraryTreeView {
  readonly #container: HTMLElement;
  readonly #callbacks: LibraryTreeCallbacks;
  readonly #rootList: HTMLUListElement;
  readonly #empty: HTMLElement;
  readonly #dragDrop: LibraryDragDrop;
  readonly #items = new Map<string, HTMLLIElement>();
  readonly #rows = new Map<string, HTMLButtonElement>();
  readonly #rowChromes = new WeakMap<HTMLButtonElement, LibraryRowChrome>();
  readonly #folderLists = new Map<string, HTMLUListElement>();
  readonly #document: Document;
  #state: LibraryTreeRenderState | null = null;
  #draft: LibraryDraft | null = null;
  #draftEditor: LibraryInlineEditor | null = null;
  #draftItem: HTMLLIElement | null = null;

  constructor(
    container: HTMLElement,
    rootDropTarget: HTMLElement,
    callbacks: LibraryTreeCallbacks,
  ) {
    this.#container = container;
    this.#callbacks = callbacks;
    this.#document = container.ownerDocument;
    this.#rootList = this.#document.createElement("ul");
    this.#rootList.className = "library-level library-level-root";
    this.#rootList.setAttribute("role", "group");
    this.#empty = this.#createEmptyState();
    this.#dragDrop = new LibraryDragDrop(container, rootDropTarget, {
      onMove: (selection, destination) => callbacks.onMove(selection, destination),
      onToggleFolder: (path, expanded) => callbacks.onToggleFolder(path, expanded),
      isFolderExpanded: (path) => this.#state?.expandedFolders.has(path) ?? false,
    });
  }

  get draft(): LibraryDraft | null {
    return this.#draft;
  }

  get draftValue(): string | null {
    if (!this.#draft) return null;
    return this.#draftEditor?.input.value ?? this.#initialDraftValue(this.#draft);
  }

  get dragging(): boolean {
    return this.#dragDrop.dragging;
  }

  cancelLiveInteraction(): void {
    this.#dragDrop.cancel();
  }

  focusSelection(selection: ConcreteSelection): void {
    const key = selection.kind === "folder" ? folderKey(selection.path) : mapKey(selection.mapId);
    this.#rows.get(key)?.focus({ preventScroll: true });
  }

  /** Expands only the hovered branch, preserving the active native drag source node. */
  expandFolderDuringDrag(path: string): boolean {
    const state = this.#state;
    if (!state || !this.#dragDrop.dragging || state.expandedFolders.has(path)) return false;
    const root = buildLibraryTree(state.payload);
    const folder = findFolderNode(root, path);
    const item = this.#items.get(folderKey(path));
    if (!folder || !item) return false;

    const expandedFolders = new Set(state.expandedFolders);
    expandedFolders.add(path);
    this.#state = { ...state, expandedFolders };
    item.setAttribute("aria-expanded", "true");
    const row = this.#rows.get(folderKey(path));
    if (row) this.#updateReadRow(row, { kind: "folder", path }, folder.name, true);
    const children = this.#renderLevel(folder, path);
    if (!children.isConnected) item.append(children);
    return true;
  }

  render(state: LibraryTreeRenderState): void {
    this.#state = state;
    const root = buildLibraryTree(state.payload);
    const hasContent = root.folders.length > 0 || root.maps.length > 0 || this.#draft !== null;
    if (hasContent) {
      this.#renderLevelInto(this.#rootList, root, "");
      if (this.#container.firstElementChild !== this.#rootList) {
        this.#container.replaceChildren(this.#rootList);
      }
    } else if (this.#container.firstElementChild !== this.#empty) {
      this.#container.replaceChildren(this.#empty);
    }
    this.#sweepCaches(root);
  }

  beginCreate(kind: "folder" | "map", parentPath: string): void {
    this.cancelDraft();
    this.#draft = { kind: kind === "folder" ? "new-folder" : "new-map", parentPath };
    this.#resetDraftEditor();
    this.#rerender();
  }

  beginRename(selection: ConcreteSelection): void {
    this.cancelDraft();
    this.#draft = { kind: "rename", selection };
    this.#resetDraftEditor();
    this.#rerender();
  }

  /** Commits a valid draft. Invalid drafts are either retained or explicitly cancelled. */
  settleDraft(cancelInvalid: boolean): boolean {
    const draft = this.#draft;
    if (!draft) return true;
    const value = this.draftValue ?? this.#initialDraftValue(draft);
    const validation = this.#callbacks.validateDraft(draft, value);
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

  takeDraftForSettle(cancelInvalid: boolean): SettledLibraryDraft | null {
    const draft = this.#draft;
    if (!draft) return null;
    const value = this.draftValue ?? this.#initialDraftValue(draft);
    const validation = this.#callbacks.validateDraft(draft, value);
    if (validation) {
      if (!cancelInvalid) this.#showDraftError(validation);
      else this.cancelDraft();
      return null;
    }
    this.#draft = null;
    this.#resetDraftEditor();
    this.#rerender();
    return { draft, value };
  }

  cancelDraft(): void {
    if (!this.#draft) return;
    this.#draft = null;
    this.#resetDraftEditor();
    this.#callbacks.onDraftCancelled?.();
    this.#rerender();
  }

  dispose(): void {
    this.#dragDrop.dispose();
    this.#resetDraftEditor();
  }

  #renderLevel(folder: FolderTreeNode, path: string): HTMLUListElement {
    let list = this.#folderLists.get(path);
    if (!list) {
      list = this.#document.createElement("ul");
      list.className = "library-level";
      list.setAttribute("role", "group");
      this.#folderLists.set(path, list);
    }
    this.#renderLevelInto(list, folder, path);
    return list;
  }

  #renderLevelInto(list: HTMLUListElement, folder: FolderTreeNode, parentPath: string): void {
    const children: HTMLElement[] = [];
    const draft = this.#draft;
    if (draft && draft.kind !== "rename" && draft.parentPath === parentPath) {
      children.push(this.#renderDraftItem(draft));
    }
    for (const child of folder.folders) children.push(this.#renderFolder(child));
    for (const map of folder.maps) children.push(this.#renderMap(map));
    list.replaceChildren(...children);
  }

  #renderFolder(folder: FolderTreeNode): HTMLLIElement {
    const state = this.#state!;
    const key = folderKey(folder.path);
    const item = this.#item(key, "library-folder");
    const expanded = state.expandedFolders.has(folder.path);
    item.setAttribute("aria-expanded", String(expanded));
    const selection: ConcreteSelection = { kind: "folder", path: folder.path };
    item.setAttribute("aria-selected", String(sameLibrarySelection(state.selection, selection)));
    item.removeAttribute("aria-current");
    const editing = this.#draft?.kind === "rename"
      && sameLibrarySelection(this.#draft.selection, selection);
    const row = editing
      ? this.#ensureDraftEditor(this.#draft!, this.#draftState("folder", expanded)).element
      : this.#readRow(key, selection, folder.name, expanded);
    const children = expanded ? this.#renderLevel(folder, folder.path) : null;
    item.replaceChildren(...(children ? [row, children] : [row]));
    return item;
  }

  #renderMap(map: LibraryMapNode): HTMLLIElement {
    const key = mapKey(map.id);
    const item = this.#item(key, "library-map");
    const selection: ConcreteSelection = { kind: "map", mapId: map.id };
    item.setAttribute("aria-selected", String(sameLibrarySelection(this.#state!.selection, selection)));
    if (this.#state!.currentMapId === map.id) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
    const editing = this.#draft?.kind === "rename"
      && sameLibrarySelection(this.#draft.selection, selection);
    const row = editing
      ? this.#ensureDraftEditor(this.#draft!, this.#draftState("map", false)).element
      : this.#readRow(key, selection, map.name, false);
    item.replaceChildren(row);
    return item;
  }

  #renderDraftItem(draft: LibraryDraft): HTMLLIElement {
    if (!this.#draftItem) {
      this.#draftItem = this.#document.createElement("li");
      this.#draftItem.className = "library-item library-draft-item";
      this.#draftItem.setAttribute("role", "treeitem");
    }
    const kind = draft.kind === "new-folder" ? "folder" : "map";
    this.#draftItem.replaceChildren(this.#ensureDraftEditor(
      draft,
      { kind, selected: false, current: false, dirty: false },
    ).element);
    return this.#draftItem;
  }

  #item(key: string, typeClass: string): HTMLLIElement {
    let item = this.#items.get(key);
    if (!item) {
      item = this.#document.createElement("li");
      item.className = `library-item ${typeClass}`;
      item.setAttribute("role", "treeitem");
      item.dataset.treeKey = key;
      this.#items.set(key, item);
    }
    return item;
  }

  #readRow(
    key: string,
    selection: ConcreteSelection,
    name: string,
    expanded: boolean,
  ): HTMLButtonElement {
    let existingRow = this.#rows.get(key);
    if (!existingRow) {
      const createdRow = this.#document.createElement("button");
      createdRow.type = "button";
      createdRow.className = "library-row";
      const chrome = createLibraryRowChrome(this.#document, createdRow);
      const label = this.#document.createElement("span");
      label.className = "library-item-name";
      chrome.nameSlot.replaceChildren(label);
      this.#rowChromes.set(createdRow, chrome);
      this.#rows.set(key, createdRow);
      createdRow.addEventListener("click", () => {
        const currentSelection = selectionForRow(createdRow);
        if (!currentSelection) return;
        this.#callbacks.onSelect(currentSelection);
        if (currentSelection.kind === "folder") {
          this.#callbacks.onToggleFolder(
            currentSelection.path,
            !(this.#state?.expandedFolders.has(currentSelection.path) ?? false),
          );
        } else {
          this.#callbacks.onOpenMap(currentSelection.mapId);
        }
      });
      existingRow = createdRow;
    }
    const row = existingRow;
    setSelectionDataset(row, selection);
    this.#dragDrop.bindRow(row, selection);
    if (selection.kind === "folder") this.#dragDrop.bindFolderTarget(row, selection.path);
    this.#updateReadRow(row, selection, name, expanded);
    return row;
  }

  #updateReadRow(
    row: HTMLButtonElement,
    selection: ConcreteSelection,
    name: string,
    expanded: boolean,
  ): void {
    const state = this.#state!;
    const chrome = this.#rowChromes.get(row);
    if (!chrome) return;
    const dirty = selection.kind === "folder"
      ? state.dirtyFolderPaths.has(selection.path)
      : state.dirtyMapIds.has(selection.mapId);
    const selected = sameLibrarySelection(state.selection, selection);
    const current = selection.kind === "map" && state.currentMapId === selection.mapId;
    updateLibraryRowChrome(chrome, {
      kind: selection.kind,
      expanded,
      selected,
      current,
      dirty,
    });
    const label = chrome.nameSlot.querySelector<HTMLElement>(".library-item-name");
    if (label && label.textContent !== name) label.textContent = name;
    if (dirty) row.setAttribute("aria-label", `${name}，有未保存修改`);
    else row.removeAttribute("aria-label");
  }

  #ensureDraftEditor(
    draft: LibraryDraft,
    state: LibraryInlineEditorState,
  ): LibraryInlineEditor {
    if (!this.#draftEditor || !sameLibraryDraft(this.#draftEditor.draft, draft)) {
      this.#draftEditor = new LibraryInlineEditor(
        this.#document,
        draft,
        this.#initialDraftValue(draft),
        state,
        {
          onCommit: (value) => { this.#attemptDraftCommit(value); },
          onCancel: () => this.cancelDraft(),
        },
      );
      const editor = this.#draftEditor;
      this.#document.defaultView?.queueMicrotask(() => {
        if (this.#draftEditor === editor) editor.focusAndSelect();
      });
    } else {
      this.#draftEditor.update(state);
    }
    return this.#draftEditor;
  }

  #draftState(kind: "folder" | "map", expanded: boolean): LibraryInlineEditorState {
    const state = this.#state!;
    const selection = this.#draft?.kind === "rename" ? this.#draft.selection : null;
    return {
      kind,
      expanded,
      selected: sameLibrarySelection(state.selection, selection),
      current: selection?.kind === "map" && state.currentMapId === selection.mapId,
      dirty: selection?.kind === "folder"
        ? state.dirtyFolderPaths.has(selection.path)
        : selection?.kind === "map" && state.dirtyMapIds.has(selection.mapId),
    };
  }

  #attemptDraftCommit(value: string): void {
    const draft = this.#draft;
    if (!draft) return;
    const validation = this.#callbacks.validateDraft(draft, value);
    if (validation) {
      this.#showDraftError(validation);
      this.#document.defaultView?.queueMicrotask(() => this.#draftEditor?.input.focus());
      return;
    }
    this.#commitDraft(value);
  }

  #commitDraft(value: string): boolean {
    const draft = this.#draft;
    if (!draft) return true;
    const error = this.#callbacks.commitDraft(draft, value);
    if (error) {
      this.#showDraftError(error);
      this.#document.defaultView?.queueMicrotask(() => this.#draftEditor?.input.focus());
      return false;
    }
    this.#draft = null;
    this.#resetDraftEditor();
    this.#rerender();
    return true;
  }

  #showDraftError(message: string): void {
    this.#draftEditor?.showError(message);
  }

  #initialDraftValue(draft: LibraryDraft): string {
    return this.#state ? draftInitialValue(draft, this.#state.payload) : "";
  }

  #resetDraftEditor(): void {
    this.#draftEditor = null;
    this.#draftItem = null;
  }

  #rerender(): void {
    if (this.#state) this.render(this.#state);
  }

  #createEmptyState(): HTMLElement {
    const empty = this.#document.createElement("div");
    empty.className = "library-empty";
    const icon = this.#document.createElement("span");
    icon.className = "library-empty-icon";
    icon.append(createIconParkIcon(this.#document, MindmapMap, {
      classNames: "mind-map-icon",
    }));
    const title = this.#document.createElement("strong");
    title.textContent = "资料库还是空的";
    const message = this.#document.createElement("p");
    message.textContent = "新建一张脑图，开始整理想法。";
    empty.append(icon, title, message);
    return empty;
  }

  #sweepCaches(root: FolderTreeNode): void {
    const keys = new Set<string>();
    const folderPaths = new Set<string>();
    collectModelKeys(root, keys, folderPaths);
    for (const key of this.#items.keys()) {
      if (!keys.has(key)) {
        this.#items.delete(key);
        this.#rows.delete(key);
      }
    }
    for (const path of this.#folderLists.keys()) {
      if (!folderPaths.has(path)) this.#folderLists.delete(path);
    }
  }
}

function folderKey(path: string): string {
  return `folder:${path}`;
}

function mapKey(id: string): string {
  return `map:${id}`;
}

function setSelectionDataset(row: HTMLElement, selection: ConcreteSelection): void {
  if (selection.kind === "folder") {
    row.dataset.folderPath = selection.path;
    delete row.dataset.mapId;
  } else {
    row.dataset.mapId = selection.mapId;
    delete row.dataset.folderPath;
  }
}

function selectionForRow(row: HTMLElement): ConcreteSelection | null {
  if (row.dataset.folderPath !== undefined) return { kind: "folder", path: row.dataset.folderPath };
  if (row.dataset.mapId !== undefined) return { kind: "map", mapId: row.dataset.mapId };
  return null;
}

function collectModelKeys(
  folder: FolderTreeNode,
  keys: Set<string>,
  folderPaths: Set<string>,
): void {
  for (const child of folder.folders) {
    keys.add(folderKey(child.path));
    folderPaths.add(child.path);
    collectModelKeys(child, keys, folderPaths);
  }
  for (const map of folder.maps) keys.add(mapKey(map.id));
}
