import type { ModuleRuntimeSnapshot } from "../../shared";

export interface MindMapShellElements {
  readonly root: HTMLElement;
  readonly homeButton: HTMLButtonElement;
  readonly sidebarButton: HTMLButtonElement;
  readonly mapTitle: HTMLElement;
  readonly versionStatus: HTMLElement;
  readonly localVersion: HTMLElement;
  readonly cloudVersion: HTMLElement;
  readonly saveButton: HTMLButtonElement;
  readonly uploadButton: HTMLButtonElement;
  readonly pullButton: HTMLButtonElement;
  readonly addNodeButton: HTMLButtonElement;
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

export class MindMapShell {
  readonly elements: MindMapShellElements;
  readonly #dialog: HTMLDialogElement;
  readonly #dialogTitle: HTMLElement;
  readonly #dialogMessage: HTMLElement;
  readonly #dialogActions: HTMLElement;
  #dialogResolve: ((choice: string) => void) | null = null;
  #toastTimer: number | null = null;

  constructor(appRoot: HTMLElement) {
    const document = appRoot.ownerDocument;
    const root = document.createElement("main");
    root.className = "mind-map-app";

    const toolbar = document.createElement("header");
    toolbar.className = "mind-map-toolbar";

    const left = document.createElement("div");
    left.className = "toolbar-group toolbar-primary";
    const homeButton = button(document, "首页", "返回首页", "toolbar-button");
    const sidebarButton = button(document, "资料库", "打开或关闭资料库", "toolbar-button");
    const mapTitle = document.createElement("h1");
    mapTitle.className = "current-map-title";
    mapTitle.textContent = "未打开脑图";
    left.append(homeButton, sidebarButton, mapTitle);

    const versionStatus = document.createElement("div");
    versionStatus.className = "version-status";
    versionStatus.setAttribute("aria-label", "本地与云端版本状态");
    const localVersion = document.createElement("span");
    localVersion.className = "version-item version-local";
    const cloudVersion = document.createElement("span");
    cloudVersion.className = "version-item version-cloud";
    versionStatus.append(localVersion, cloudVersion);

    const actions = document.createElement("div");
    actions.className = "toolbar-group toolbar-actions";
    const saveButton = button(document, "保存", "保存到本机（Ctrl+S）");
    const uploadButton = button(document, "上传", "上传到云端");
    const pullButton = button(document, "拉取", "用云端版本更新本机");
    const addNodeButton = button(document, "文本", "添加文本节点（Alt+1）");
    const addArrowButton = button(document, "箭头", "添加箭头（Alt+2）");
    const resetViewButton = button(document, "复位", "适配并居中全部节点");
    actions.append(
      saveButton,
      uploadButton,
      pullButton,
      addNodeButton,
      addArrowButton,
      resetViewButton,
    );
    toolbar.append(left, versionStatus, actions);

    const workspace = document.createElement("section");
    workspace.className = "mind-map-workspace";
    const sidebar = document.createElement("aside");
    sidebar.className = "mind-map-library";
    sidebar.setAttribute("aria-label", "思维导图资料库");

    const sidebarHeader = document.createElement("header");
    sidebarHeader.className = "library-header";
    const sidebarTitle = document.createElement("h2");
    sidebarTitle.textContent = "资料库";
    const libraryActions = document.createElement("div");
    libraryActions.className = "library-actions";
    const newFolderButton = button(document, "新文件夹", "新建文件夹", "library-button");
    const newMapButton = button(document, "新脑图", "新建脑图", "library-button");
    const renameButton = button(document, "重命名", "重命名所选项目", "library-button");
    const deleteButton = button(document, "删除", "删除所选项目", "library-button danger-button");
    libraryActions.append(newFolderButton, newMapButton, renameButton, deleteButton);
    sidebarHeader.append(sidebarTitle, libraryActions);

    const rootDropTarget = document.createElement("div");
    rootDropTarget.className = "library-root-drop";
    rootDropTarget.textContent = "资料库根目录";
    rootDropTarget.dataset.dropTarget = "root";
    const tree = document.createElement("div");
    tree.className = "library-tree";
    tree.setAttribute("role", "tree");
    tree.tabIndex = -1;
    sidebar.append(sidebarHeader, rootDropTarget, tree);

    const canvasArea = document.createElement("section");
    canvasArea.className = "mind-map-canvas-area";
    canvasArea.setAttribute("aria-label", "思维导图画布");
    const canvasMount = document.createElement("div");
    canvasMount.className = "mind-map-canvas-mount";
    const canvasEmpty = document.createElement("div");
    canvasEmpty.className = "canvas-empty";
    canvasEmpty.textContent = "从左侧资料库新建或打开一张脑图。";
    canvasArea.append(canvasMount, canvasEmpty);
    workspace.append(sidebar, canvasArea);

    const toast = document.createElement("div");
    toast.className = "mind-map-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.hidden = true;

    const dialog = document.createElement("dialog");
    dialog.className = "mind-map-dialog";
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    const dialogTitle = document.createElement("h2");
    dialogTitle.className = "dialog-title";
    const dialogMessage = document.createElement("p");
    dialogMessage.className = "dialog-message";
    const dialogActions = document.createElement("div");
    dialogActions.className = "dialog-actions";
    dialog.append(dialogTitle, dialogMessage, dialogActions);

    root.append(toolbar, workspace, toast, dialog);
    appRoot.replaceChildren(root);

    this.#dialog = dialog;
    this.#dialogTitle = dialogTitle;
    this.#dialogMessage = dialogMessage;
    this.#dialogActions = dialogActions;
    this.elements = {
      root,
      homeButton,
      sidebarButton,
      mapTitle,
      versionStatus,
      localVersion,
      cloudVersion,
      saveButton,
      uploadButton,
      pullButton,
      addNodeButton,
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
      toast,
    };
  }

  setSidebarOpen(open: boolean): void {
    this.elements.root.classList.toggle("sidebar-open", open);
    this.elements.sidebar.hidden = !open;
    this.elements.sidebarButton.setAttribute("aria-pressed", String(open));
  }

  setMapTitle(title: string | null, dirty: boolean): void {
    this.elements.mapTitle.textContent = title ? `${title}${dirty ? " *" : ""}` : "未打开脑图";
    this.elements.mapTitle.title = title ?? "";
    this.elements.canvasEmpty.hidden = title !== null;
    this.elements.canvasMount.hidden = title === null;
    this.elements.addNodeButton.disabled = title === null;
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

  renderSnapshot(snapshot: ModuleRuntimeSnapshot): void {
    const localVersion = snapshot.localSavedAt
      ? `本地：${formatTimestamp(snapshot.localSavedAt)}`
      : "本地：时间未知";
    const localText = snapshot.sessionDirty
      ? `${localVersion}（有未保存修改）`
      : localVersion;
    const cloudText = snapshot.knownRemoteUpdatedAt
      ? `云端：${formatTimestamp(snapshot.knownRemoteUpdatedAt)}`
      : snapshot.knownRemoteRevision
        ? "云端：时间未知"
        : "云端：尚无版本";
    this.elements.localVersion.textContent = localText;
    this.elements.cloudVersion.textContent = cloudText;
    this.elements.localVersion.title = snapshot.localSavedAt ?? "";
    this.elements.cloudVersion.title = snapshot.knownRemoteUpdatedAt ?? "";

    const state = snapshot.conflict
      ? "conflict"
      : snapshot.pendingUpload
        ? "pending"
        : snapshot.sessionDirty || snapshot.localChangedSinceSync
          ? "local-ahead"
          : "synced";
    this.elements.versionStatus.dataset.state = state;
    this.elements.versionStatus.title = snapshot.conflict
      ? "本地与云端发生冲突，请使用上传或拉取选择保留方向。"
      : snapshot.pendingUpload
        ? "上传结果尚待确认。"
        : snapshot.sessionDirty
          ? "有尚未保存到本机的修改。"
          : snapshot.localChangedSinceSync
          ? "本地版本尚未上传。"
          : "本地与云端状态一致。";
  }

  showMessage(message: string, tone: "normal" | "error" = "normal"): void {
    if (this.#toastTimer !== null) {
      window.clearTimeout(this.#toastTimer);
    }
    this.elements.toast.textContent = message;
    this.elements.toast.dataset.tone = tone;
    this.elements.toast.hidden = false;
    this.#toastTimer = window.setTimeout(() => {
      this.elements.toast.hidden = true;
      this.#toastTimer = null;
    }, 4200);
  }

  choose(title: string, message: string, choices: readonly DialogChoice[]): Promise<string> {
    if (this.#dialog.open) {
      this.#dialogResolve?.("cancel");
      this.#dialog.close();
    }
    this.#dialogTitle.textContent = title;
    this.#dialogMessage.textContent = message;
    this.#dialogActions.replaceChildren();
    return new Promise((resolve) => {
      this.#dialogResolve = resolve;
      for (const choice of choices) {
        const choiceButton = button(
          this.#dialog.ownerDocument,
          choice.label,
          choice.label,
          `dialog-button ${choice.tone ?? "neutral"}`,
        );
        choiceButton.addEventListener("click", () => {
          this.#dialogResolve = null;
          this.#dialog.close();
          resolve(choice.id);
        });
        this.#dialogActions.append(choiceButton);
      }
      this.#dialog.showModal();
    });
  }

  dispose(): void {
    if (this.#toastTimer !== null) window.clearTimeout(this.#toastTimer);
    if (this.#dialog.open) this.#dialog.close();
    this.#dialogResolve?.("cancel");
    this.#dialogResolve = null;
  }
}

function button(
  document: Document,
  text: string,
  title: string,
  className = "toolbar-button",
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  element.title = title;
  return element;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
