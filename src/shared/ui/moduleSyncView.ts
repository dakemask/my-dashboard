import { DownloadOne, UploadOne } from "@icon-park/svg";
import { createIconOnlyButton } from "./iconPark";
import type {
  ModuleSyncAction,
  ModuleSyncMessageTone,
} from "./moduleSyncActions";
import type { ModuleSyncViewModel } from "./moduleSyncViewModel";

export interface ModuleSyncViewOptions {
  readonly mount: HTMLElement;
  readonly onAction: (action: ModuleSyncAction) => void;
}

export class ModuleSyncView {
  readonly #mount: HTMLElement;
  readonly #region: HTMLElement;
  readonly #state: HTMLElement;
  readonly #localVersion: HTMLElement;
  readonly #cloudVersion: HTMLElement;
  readonly #actions: HTMLElement;
  readonly #uploadButton: HTMLButtonElement;
  readonly #pullButton: HTMLButtonElement;
  readonly #toast: HTMLElement;
  readonly #dialog: HTMLDialogElement;
  readonly #dialogTitle: HTMLElement;
  readonly #dialogMessage: HTMLElement;
  readonly #dialogActions: HTMLElement;
  readonly #listeners: Array<() => void> = [];
  #disposed = false;
  #toastTimer: number | null = null;
  #dialogResolve: ((confirmed: boolean) => void) | null = null;
  #dialogTrigger: HTMLElement | null = null;
  #lastActionTrigger: HTMLButtonElement | null = null;
  #pendingFocusTrigger: HTMLElement | null = null;

  constructor(options: ModuleSyncViewOptions) {
    this.#mount = options.mount;
    const document = options.mount.ownerDocument;
    const region = document.createElement("section");
    region.className = "shared-module-sync";
    region.setAttribute("aria-label", "本地保存与云端同步");

    const summary = document.createElement("div");
    summary.className = "shared-module-sync-summary";
    const heading = document.createElement("div");
    heading.className = "shared-module-sync-heading";
    const dot = document.createElement("span");
    dot.className = "shared-module-sync-dot";
    dot.setAttribute("aria-hidden", "true");
    const state = document.createElement("strong");
    state.className = "shared-module-sync-state";
    heading.append(dot, state);

    const versions = document.createElement("div");
    versions.className = "shared-module-sync-versions";
    const localVersion = document.createElement("span");
    const cloudVersion = document.createElement("span");
    versions.append(localVersion, cloudVersion);
    summary.append(heading, versions);

    const actions = document.createElement("div");
    actions.className = "shared-module-sync-actions";
    const uploadButton = createActionButton(document, "上传", "upload", UploadOne);
    const pullButton = createActionButton(document, "拉取", "pull", DownloadOne);
    actions.append(uploadButton, pullButton);
    region.append(summary, actions);

    const toast = document.createElement("div");
    toast.className = "shared-module-sync-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.hidden = true;

    const dialog = document.createElement("dialog");
    dialog.className = "shared-module-sync-dialog";
    const dialogTitle = document.createElement("h2");
    dialogTitle.className = "shared-module-sync-dialog-title";
    const dialogMessage = document.createElement("p");
    dialogMessage.className = "shared-module-sync-dialog-message";
    const dialogActions = document.createElement("div");
    dialogActions.className = "shared-module-sync-dialog-actions";
    const dialogId = `shared-module-sync-dialog-${nextDialogId()}`;
    dialogTitle.id = `${dialogId}-title`;
    dialogMessage.id = `${dialogId}-message`;
    dialog.setAttribute("aria-labelledby", dialogTitle.id);
    dialog.setAttribute("aria-describedby", dialogMessage.id);
    dialog.append(dialogTitle, dialogMessage, dialogActions);

    options.mount.replaceChildren(region, toast, dialog);
    this.#region = region;
    this.#state = state;
    this.#localVersion = localVersion;
    this.#cloudVersion = cloudVersion;
    this.#actions = actions;
    this.#uploadButton = uploadButton;
    this.#pullButton = pullButton;
    this.#toast = toast;
    this.#dialog = dialog;
    this.#dialogTitle = dialogTitle;
    this.#dialogMessage = dialogMessage;
    this.#dialogActions = dialogActions;

    this.#listen(uploadButton, "click", () => {
      this.#lastActionTrigger = uploadButton;
      options.onAction("upload");
    });
    this.#listen(pullButton, "click", () => {
      this.#lastActionTrigger = pullButton;
      options.onAction("pull");
    });
    this.#listen(dialog, "cancel", (event) => {
      event.preventDefault();
      this.#resolveDialog(false);
    });
  }

  render(model: ModuleSyncViewModel): void {
    if (this.#disposed) return;
    this.#region.dataset.state = model.state;
    if (model.mode) this.#region.dataset.mode = model.mode;
    else delete this.#region.dataset.mode;
    if (model.busy) this.#region.setAttribute("aria-busy", "true");
    else this.#region.removeAttribute("aria-busy");
    this.#state.textContent = model.busyText ?? model.stateText;
    this.#localVersion.textContent = model.localVersionText;
    this.#localVersion.title = model.localVersionTitle;
    this.#cloudVersion.textContent = model.cloudVersionText;
    this.#cloudVersion.title = model.cloudVersionTitle;
    this.#region.title = model.regionTitle;
    this.#cloudVersion.hidden = model.cloudVersionHidden;
    this.#actions.hidden = model.actionsHidden;
    this.#uploadButton.disabled = model.actionsDisabled;
    this.#pullButton.disabled = model.actionsDisabled;
    const pendingFocus = this.#pendingFocusTrigger;
    if (
      pendingFocus
      && pendingFocus.isConnected
      && (!(pendingFocus instanceof HTMLButtonElement) || !pendingFocus.disabled)
    ) {
      this.#pendingFocusTrigger = null;
      pendingFocus.focus();
    }
  }

  showMessage(
    message: string,
    tone: ModuleSyncMessageTone = "normal",
    duration = tone === "error" ? 6200 : 4200,
  ): void {
    if (this.#disposed) return;
    const pageWindow = this.#mount.ownerDocument.defaultView;
    if (this.#toastTimer !== null) pageWindow?.clearTimeout(this.#toastTimer);
    this.#toast.textContent = message;
    this.#toast.dataset.tone = tone;
    this.#toast.setAttribute("role", tone === "error" ? "alert" : "status");
    this.#toast.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    this.#toast.hidden = false;
    this.#toastTimer = pageWindow?.setTimeout(() => {
      this.#toast.hidden = true;
      this.#toastTimer = null;
    }, duration) ?? null;
  }

  confirmLocalWins(): Promise<boolean> {
    return this.#confirm(
      "用本地版本覆盖云端？",
      "本地和云端都已变化。继续会以本模块的本地完整数据覆盖云端。",
      "本地覆盖云端",
    );
  }

  confirmCloudWins(): Promise<boolean> {
    return this.#confirm(
      "用云端版本覆盖本地？",
      "继续会丢弃本模块尚未上传的本地变化，并以云端完整数据替换本机。",
      "云端覆盖本地",
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const remove of this.#listeners.splice(0)) remove();
    const pageWindow = this.#mount.ownerDocument.defaultView;
    if (this.#toastTimer !== null) {
      pageWindow?.clearTimeout(this.#toastTimer);
      this.#toastTimer = null;
    }
    this.#resolveDialog(false);
    this.#mount.replaceChildren();
  }

  #confirm(
    title: string,
    message: string,
    confirmLabel: string,
  ): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    this.#resolveDialog(false);
    this.#dialogTitle.textContent = title;
    this.#dialogMessage.textContent = message;
    const document = this.#dialog.ownerDocument;
    const cancelButton = createDialogButton(document, "取消", "neutral");
    const confirmButton = createDialogButton(document, confirmLabel, "danger");
    this.#dialogActions.replaceChildren(cancelButton, confirmButton);
    const activeElement = document.activeElement;
    this.#dialogTrigger = activeElement instanceof HTMLElement
      && activeElement !== document.body
      ? activeElement
      : this.#lastActionTrigger;

    return new Promise((resolve) => {
      this.#dialogResolve = resolve;
      cancelButton.addEventListener(
        "click",
        () => this.#resolveDialog(false),
        { once: true },
      );
      confirmButton.addEventListener(
        "click",
        () => this.#resolveDialog(true),
        { once: true },
      );
      this.#dialog.showModal();
      cancelButton.focus();
    });
  }

  #resolveDialog(confirmed: boolean): void {
    const resolve = this.#dialogResolve;
    if (!resolve) return;
    this.#dialogResolve = null;
    if (this.#dialog.open) this.#dialog.close();
    const trigger = this.#dialogTrigger;
    this.#dialogTrigger = null;
    if (trigger?.isConnected) {
      if (trigger instanceof HTMLButtonElement && trigger.disabled) {
        this.#pendingFocusTrigger = trigger;
      } else {
        trigger.focus();
      }
    }
    resolve(confirmed);
  }

  #listen(
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
  ): void {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }
}

function createActionButton(
  document: Document,
  label: string,
  action: ModuleSyncAction,
  icon: Parameters<typeof createIconOnlyButton>[1],
): HTMLButtonElement {
  const button = createIconOnlyButton(document, icon, label, {
    classNames: "shared-module-sync-button",
    iconClassNames: "shared-module-sync-icon",
  });
  button.dataset.action = action;
  return button;
}

function createDialogButton(
  document: Document,
  label: string,
  tone: "danger" | "neutral",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "shared-module-sync-dialog-button";
  button.dataset.tone = tone;
  button.textContent = label;
  return button;
}

let dialogSequence = 0;

function nextDialogId(): number {
  dialogSequence += 1;
  return dialogSequence;
}
