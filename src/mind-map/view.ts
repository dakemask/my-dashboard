import { queryRequired } from "../shared/dom";
import type { PrivateDataSettings } from "../shared/privateData/types";
import { getMapTitleFromPath } from "./mindMapLibrary";
import type { MindMapLibraryEntry, MindMapLibrarySelection } from "./types";

export interface MindMapElements {
  settingsBtn: HTMLButtonElement;
  settingsPanel: HTMLElement;
  ownerInput: HTMLInputElement;
  repoInput: HTMLInputElement;
  branchInput: HTMLInputElement;
  pathInput: HTMLInputElement;
  tokenInput: HTMLInputElement;
  saveSettingsBtn: HTMLButtonElement;
  clearSettingsBtn: HTMLButtonElement;
  addNodeBtn: HTMLButtonElement;
  connectBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  status: HTMLElement;
  saveOverlay: HTMLElement;
  mapHost: HTMLDivElement;
  currentMapTitle: HTMLElement;
  libraryRootLabel: HTMLElement;
  libraryTree: HTMLElement;
  refreshLibraryBtn: HTMLButtonElement;
  newFolderBtn: HTMLButtonElement;
  newMapBtn: HTMLButtonElement;
  renameEntryBtn: HTMLButtonElement;
  moveEntryBtn: HTMLButtonElement;
  deleteEntryBtn: HTMLButtonElement;
  contextMenu: HTMLElement;
  contextDeleteBtn: HTMLButtonElement;
}

export function getMindMapElements(): MindMapElements {
  return {
    settingsBtn: queryRequired("#settingsBtn"),
    settingsPanel: queryRequired("#settingsPanel"),
    ownerInput: queryRequired("#ownerInput"),
    repoInput: queryRequired("#repoInput"),
    branchInput: queryRequired("#branchInput"),
    pathInput: queryRequired("#pathInput"),
    tokenInput: queryRequired("#tokenInput"),
    saveSettingsBtn: queryRequired("#saveSettingsBtn"),
    clearSettingsBtn: queryRequired("#clearSettingsBtn"),
    addNodeBtn: queryRequired("#addNodeBtn"),
    connectBtn: queryRequired("#connectBtn"),
    saveBtn: queryRequired("#saveBtn"),
    refreshBtn: queryRequired("#refreshBtn"),
    resetBtn: queryRequired("#resetBtn"),
    status: queryRequired("#status"),
    saveOverlay: queryRequired("#saveOverlay"),
    mapHost: queryRequired("#mapHost"),
    currentMapTitle: queryRequired("#currentMapTitle"),
    libraryRootLabel: queryRequired("#libraryRootLabel"),
    libraryTree: queryRequired("#libraryTree"),
    refreshLibraryBtn: queryRequired("#refreshLibraryBtn"),
    newFolderBtn: queryRequired("#newFolderBtn"),
    newMapBtn: queryRequired("#newMapBtn"),
    renameEntryBtn: queryRequired("#renameEntryBtn"),
    moveEntryBtn: queryRequired("#moveEntryBtn"),
    deleteEntryBtn: queryRequired("#deleteEntryBtn"),
    contextMenu: queryRequired("#contextMenu"),
    contextDeleteBtn: queryRequired("#contextDeleteBtn"),
  };
}

export function setStatus(elements: MindMapElements, message = ""): void {
  elements.status.textContent = message;
}

export function setSaveOverlayVisible(elements: MindMapElements, visible: boolean): void {
  elements.saveOverlay.classList.toggle("hidden", !visible);
  elements.saveOverlay.setAttribute("aria-hidden", String(!visible));
  elements.mapHost.setAttribute("aria-busy", String(visible));
}

export function fillSettingsForm(elements: MindMapElements, settings: PrivateDataSettings): void {
  elements.ownerInput.value = settings.owner;
  elements.repoInput.value = settings.repo;
  elements.branchInput.value = settings.branch;
  elements.pathInput.value = settings.path;
  elements.tokenInput.value = settings.token;
}

export function readSettingsForm(elements: MindMapElements): PrivateDataSettings {
  return {
    owner: elements.ownerInput.value.trim(),
    repo: elements.repoInput.value.trim(),
    branch: elements.branchInput.value.trim(),
    path: elements.pathInput.value.trim(),
    token: elements.tokenInput.value.trim(),
  };
}

export function setCurrentMapTitle(elements: MindMapElements, title: string, dirty: boolean): void {
  elements.currentMapTitle.textContent = dirty ? `${title} *` : title;
}

export function setLibraryRootLabel(elements: MindMapElements, rootPath: string): void {
  elements.libraryRootLabel.textContent = rootPath;
}

export function setMapToolsEnabled(elements: MindMapElements, mapOpen: boolean, hasLibraryChanges: boolean): void {
  elements.addNodeBtn.disabled = !mapOpen;
  elements.connectBtn.disabled = !mapOpen;
  elements.saveBtn.disabled = !mapOpen && !hasLibraryChanges;
  elements.refreshBtn.disabled = false;
}

export function setLibraryActionState(
  elements: MindMapElements,
  settingsReady: boolean,
  selection: MindMapLibrarySelection,
): void {
  elements.refreshLibraryBtn.disabled = !settingsReady;
  elements.newFolderBtn.disabled = !settingsReady;
  elements.newMapBtn.disabled = !settingsReady;
  elements.renameEntryBtn.disabled = !settingsReady || !selection;
  elements.moveEntryBtn.disabled = !settingsReady || !selection;
  elements.deleteEntryBtn.disabled = !settingsReady || !selection;
}

export function renderLibraryTree(
  elements: MindMapElements,
  entries: MindMapLibraryEntry[],
  selectedPath: string | null,
  currentMapPath: string | null,
  dirtyContentPaths: ReadonlySet<string>,
  treeChangePaths: ReadonlySet<string>,
): void {
  elements.libraryTree.textContent = "";

  if (entries.length === 0) {
    const empty = document.createElement("p");

    empty.className = "library-empty";
    empty.textContent = "还没有导图。";
    elements.libraryTree.append(empty);
    return;
  }

  const list = document.createElement("ul");

  list.className = "library-list";
  list.setAttribute("role", "tree");
  appendLibraryEntries(list, entries, 0, selectedPath, currentMapPath, dirtyContentPaths, treeChangePaths);
  elements.libraryTree.append(list);
}

export function setConnectMode(elements: MindMapElements, enabled: boolean): void {
  elements.connectBtn.classList.toggle("active", enabled);
  elements.connectBtn.setAttribute("aria-pressed", String(enabled));
}

export function showContextMenu(elements: MindMapElements, x: number, y: number): void {
  elements.contextMenu.classList.remove("hidden");
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.top = `${y}px`;

  const bounds = elements.contextMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - bounds.width - 8);
  const top = Math.min(y, window.innerHeight - bounds.height - 8);

  elements.contextMenu.style.left = `${Math.max(8, left)}px`;
  elements.contextMenu.style.top = `${Math.max(8, top)}px`;
}

export function hideContextMenu(elements: MindMapElements): void {
  elements.contextMenu.classList.add("hidden");
}

function appendLibraryEntries(
  list: HTMLUListElement,
  entries: MindMapLibraryEntry[],
  depth: number,
  selectedPath: string | null,
  currentMapPath: string | null,
  dirtyContentPaths: ReadonlySet<string>,
  treeChangePaths: ReadonlySet<string>,
): void {
  for (const entry of entries) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const icon = document.createElement("span");
    const name = document.createElement("span");

    item.className = "library-item";
    item.style.setProperty("--depth", String(depth));
    button.type = "button";
    button.className = "library-entry";
    button.dataset.libraryPath = entry.path;
    button.dataset.libraryKind = entry.kind;
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-selected", String(entry.path === selectedPath));
    button.classList.toggle("selected", entry.path === selectedPath);
    button.classList.toggle("current", entry.kind === "map" && entry.path === currentMapPath);
    button.classList.toggle("pending", treeChangePaths.has(entry.path));
    icon.className = "library-entry-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = entry.kind === "folder" ? ">" : "-";
    name.className = "library-entry-name";
    name.textContent = getLibraryEntryLabel(entry, dirtyContentPaths, treeChangePaths);
    button.append(icon, name);
    item.append(button);
    list.append(item);

    if (entry.kind === "folder" && entry.children.length > 0) {
      appendLibraryEntries(list, entry.children, depth + 1, selectedPath, currentMapPath, dirtyContentPaths, treeChangePaths);
    }
  }
}

function getLibraryEntryLabel(
  entry: MindMapLibraryEntry,
  dirtyContentPaths: ReadonlySet<string>,
  treeChangePaths: ReadonlySet<string>,
): string {
  const name = entry.kind === "map" ? getMapTitleFromPath(entry.path) : entry.name;
  const dirty = treeChangePaths.has(entry.path) || (entry.kind === "map" && dirtyContentPaths.has(entry.path));

  return dirty ? `${name} *` : name;
}
