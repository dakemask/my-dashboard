import { Down, FolderClose, FolderOpen, MindmapMap } from "@icon-park/svg";
import { createIconParkIcon } from "../../shared";

export type LibraryRowKind = "folder" | "map";

export interface LibraryRowChrome {
  readonly root: HTMLElement;
  readonly arrow: HTMLElement;
  readonly icon: HTMLElement;
  readonly nameSlot: HTMLElement;
  readonly dirtyMarker: HTMLElement;
}

export function createLibraryRowChrome(
  document: Document,
  root: HTMLElement,
): LibraryRowChrome {
  root.classList.add("library-row-chrome");
  const arrow = document.createElement("span");
  arrow.className = "folder-arrow";
  const icon = document.createElement("span");
  icon.className = "library-item-icon";
  const nameSlot = document.createElement("span");
  nameSlot.className = "library-name-slot";
  const dirtyMarker = document.createElement("span");
  dirtyMarker.className = "library-dirty-marker";
  dirtyMarker.textContent = "*";
  dirtyMarker.title = "有未保存修改";
  dirtyMarker.setAttribute("aria-hidden", "true");
  dirtyMarker.hidden = true;
  root.append(arrow, icon, nameSlot, dirtyMarker);
  return { root, arrow, icon, nameSlot, dirtyMarker };
}

export function updateLibraryRowChrome(
  chrome: LibraryRowChrome,
  options: {
    readonly kind: LibraryRowKind;
    readonly expanded?: boolean;
    readonly selected: boolean;
    readonly current: boolean;
    readonly dirty: boolean;
  },
): void {
  const document = chrome.root.ownerDocument;
  chrome.root.classList.toggle("selected", options.selected);
  chrome.root.classList.toggle("current", options.current);
  chrome.root.classList.toggle("dirty", options.dirty);
  chrome.dirtyMarker.hidden = !options.dirty;

  chrome.arrow.classList.toggle("folder-arrow-spacer", options.kind !== "folder");
  chrome.arrow.replaceChildren();
  if (options.kind === "folder") {
    chrome.arrow.append(createIconParkIcon(document, Down, {
      size: 14,
      classNames: "mind-maps-icon",
    }));
  }

  chrome.icon.classList.toggle("library-folder-icon", options.kind === "folder");
  chrome.icon.classList.toggle("map-icon", options.kind === "map");
  chrome.icon.replaceChildren(createIconParkIcon(
    document,
    options.kind === "folder" && options.expanded ? FolderOpen
      : options.kind === "folder" ? FolderClose
        : MindmapMap,
    { size: 16, classNames: "mind-maps-icon" },
  ));
}
