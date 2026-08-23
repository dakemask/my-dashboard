import {
  AddText,
  AutoFocus,
  CodeBrackets,
  ConnectionArrow,
  Delete,
  Edit,
  FileAddition,
  FolderPlus,
  Home,
  MindmapList,
  Save,
} from "@icon-park/svg";
import {
  createIconOnlyButton,
  createIconParkIcon,
  type IconParkRenderer,
} from "../../shared";

export interface MindMapPageElements {
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
}

/** Static page chrome and simple projections; business commands stay in the controller. */
export class MindMapPageView {
  readonly elements: MindMapPageElements;

  constructor(appRoot: HTMLElement) {
    const document = appRoot.ownerDocument;
    const root = document.createElement("main");
    root.className = "mind-maps-app";

    const toolbar = document.createElement("header");
    toolbar.className = "mind-maps-toolbar";
    const left = document.createElement("div");
    left.className = "toolbar-group toolbar-identity";
    const homeButton = iconButton(document, Home, "返回首页", "toolbar-button toolbar-icon-button");
    const sidebarButton = iconButton(
      document,
      MindmapList,
      "打开或关闭资料库",
      "toolbar-button toolbar-icon-button",
    );
    sidebarButton.setAttribute("aria-controls", "mind-maps-library-panel");

    const titleCopy = document.createElement("div");
    titleCopy.className = "toolbar-title-copy";
    const eyebrow = document.createElement("span");
    eyebrow.className = "toolbar-eyebrow";
    eyebrow.textContent = "思维导图";
    const mapTitle = document.createElement("h1");
    mapTitle.className = "current-map-title";
    mapTitle.textContent = "未打开脑图";
    titleCopy.append(eyebrow, mapTitle);
    left.append(homeButton, sidebarButton, titleCopy);

    const syncMount = document.createElement("div");
    syncMount.className = "mind-maps-sync-mount";
    const actions = document.createElement("div");
    actions.className = "toolbar-group toolbar-actions";
    const retrySaveButton = iconButton(
      document,
      Save,
      "自动保存失败，重试保存到本机",
      "toolbar-button toolbar-icon-button",
    );
    retrySaveButton.hidden = true;
    const canvasActions = document.createElement("div");
    canvasActions.className = "toolbar-cluster";
    const addNodeButton = iconButton(
      document,
      AddText,
      "添加文本节点（Alt+1）",
      "toolbar-button toolbar-icon-button",
    );
    const addBracketButton = iconButton(
      document,
      CodeBrackets,
      "添加括号（Alt+3）",
      "toolbar-button toolbar-icon-button",
    );
    const addArrowButton = iconButton(
      document,
      ConnectionArrow,
      "添加箭头（Alt+2）",
      "toolbar-button toolbar-icon-button",
    );
    const resetViewButton = iconButton(
      document,
      AutoFocus,
      "适配并居中全部内容",
      "toolbar-button toolbar-icon-button",
    );
    canvasActions.append(addNodeButton, addArrowButton, addBracketButton, resetViewButton);
    actions.append(retrySaveButton, canvasActions);
    toolbar.append(left, syncMount, actions);

    const workspace = document.createElement("section");
    workspace.className = "mind-maps-workspace";
    const sidebar = document.createElement("aside");
    sidebar.className = "mind-maps-library";
    sidebar.id = "mind-maps-library-panel";
    sidebar.setAttribute("aria-label", "思维导图资料库");
    const sidebarHeader = document.createElement("header");
    sidebarHeader.className = "library-header";
    const sidebarHeading = document.createElement("div");
    sidebarHeading.className = "library-heading";
    const sidebarTitle = document.createElement("h2");
    sidebarTitle.textContent = "文件夹";
    sidebarHeading.append(sidebarTitle);
    const libraryActions = document.createElement("div");
    libraryActions.className = "library-actions";
    const newFolderButton = iconButton(
      document,
      FolderPlus,
      "新建文件夹",
      "library-button library-icon-button",
      16,
    );
    const newMapButton = iconButton(
      document,
      FileAddition,
      "新建脑图",
      "library-button library-icon-button",
      16,
    );
    const renameButton = iconButton(
      document,
      Edit,
      "重命名所选项目",
      "library-button library-icon-button",
      16,
    );
    const deleteButton = iconButton(
      document,
      Delete,
      "删除所选项目",
      "library-button library-icon-button danger-button",
      16,
    );
    libraryActions.append(newFolderButton, newMapButton, renameButton, deleteButton);
    sidebarHeader.append(sidebarHeading, libraryActions);

    const rootDropTarget = document.createElement("div");
    rootDropTarget.className = "library-root-drop";
    rootDropTarget.dataset.dropTarget = "root";
    rootDropTarget.append(
      createIconParkIcon(document, MindmapList, {
        size: 16,
        classNames: ["mind-maps-icon", "library-root-icon"],
      }),
      document.createTextNode("拖到这里移至根目录"),
    );
    const tree = document.createElement("div");
    tree.className = "library-tree";
    tree.setAttribute("role", "tree");
    tree.tabIndex = -1;
    sidebar.append(sidebarHeader, rootDropTarget, tree);

    const canvasArea = document.createElement("section");
    canvasArea.className = "mind-maps-canvas-area";
    canvasArea.setAttribute("aria-label", "思维导图画布");
    const canvasMount = document.createElement("div");
    canvasMount.className = "mind-maps-canvas-mount";
    const canvasEmpty = document.createElement("div");
    canvasEmpty.className = "canvas-empty";
    canvasArea.append(canvasMount, canvasEmpty);
    workspace.append(sidebar, canvasArea);
    root.append(toolbar, workspace);
    appRoot.replaceChildren(root);

    this.elements = {
      root,
      homeButton,
      sidebarButton,
      mapTitle,
      syncMount,
      retrySaveButton,
      addNodeButton,
      addBracketButton,
      addArrowButton,
      resetViewButton,
      sidebar,
      newFolderButton,
      newMapButton,
      renameButton,
      deleteButton,
      rootDropTarget,
      tree,
      canvasArea,
      canvasMount,
      canvasEmpty,
    };
  }

  setSidebarOpen(open: boolean): void {
    this.elements.root.classList.toggle("sidebar-open", open);
    this.elements.sidebar.inert = !open;
    this.elements.sidebar.setAttribute("aria-hidden", String(!open));
    this.elements.sidebarButton.setAttribute("aria-expanded", String(open));
  }

  setMapTitle(title: string | null, dirty: boolean): void {
    this.elements.mapTitle.textContent = title ? `${title}${dirty ? " *" : ""}` : "未打开脑图";
    this.elements.mapTitle.title = title ?? "";
    this.elements.canvasEmpty.hidden = title !== null;
    this.elements.canvasMount.hidden = title === null;
    this.elements.addNodeButton.disabled = title === null;
    this.elements.addBracketButton.disabled = title === null;
    this.elements.addArrowButton.disabled = title === null;
    this.elements.resetViewButton.disabled = title === null;
  }

  setLibrarySelectionAvailable(available: boolean): void {
    this.elements.renameButton.disabled = !available;
    this.elements.deleteButton.disabled = !available;
  }

  setArrowMode(active: boolean): void {
    this.elements.addArrowButton.classList.toggle("active", active);
    this.elements.addArrowButton.setAttribute("aria-pressed", String(active));
  }

  setSaveRetryVisible(visible: boolean): void {
    this.elements.retrySaveButton.hidden = !visible;
  }
}

function iconButton(
  document: Document,
  renderer: IconParkRenderer,
  label: string,
  classNames: string,
  iconSize = 20,
): HTMLButtonElement {
  const button = createIconOnlyButton(document, renderer, label, {
    classNames: [classNames, "icon-only"],
    iconClassNames: "mind-maps-icon",
    iconSize,
  });
  return button;
}
