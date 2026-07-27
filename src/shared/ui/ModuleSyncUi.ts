import {
  DownloadOne,
  UploadOne,
} from "@icon-park/svg";
import type {
  ConflictResolution,
  SyncActionResult,
  SyncCoordinatorSnapshot,
} from "../sync";

export type ModuleSyncAction = "upload" | "pull";

export type ModuleSyncGateResult =
  | { readonly status: "ready" }
  | { readonly status: "blocked"; readonly message: string };

export interface ModuleSyncUiRuntime {
  upload(): Promise<SyncActionResult>;
  pull(): Promise<SyncActionResult>;
  resolveConflict(strategy: ConflictResolution): Promise<SyncActionResult>;
  getSnapshot(): SyncCoordinatorSnapshot;
}

export interface ModuleSyncUiOptions {
  readonly mount: HTMLElement;
  readonly guardAction: (
    action: ModuleSyncAction,
  ) => ModuleSyncGateResult | Promise<ModuleSyncGateResult>;
}

const EMPTY_SNAPSHOT: SyncCoordinatorSnapshot = {
  initialized: false,
  sessionDirty: false,
  localChangedSinceSync: false,
  businessChangedSinceSync: false,
  migrationChangedSinceSync: false,
  localSavedAt: null,
  knownRemoteRevision: null,
  knownRemoteUpdatedAt: null,
  lastSyncedRemoteRevision: null,
  pendingUpload: null,
  conflict: null,
};

/**
 * Shared presentation and command flow for manual cloud synchronization.
 * Modules provide only their business gate.
 */
export class ModuleSyncUi {
  readonly #mount: HTMLElement;
  readonly #guardAction: ModuleSyncUiOptions["guardAction"];
  readonly #region: HTMLElement;
  readonly #state: HTMLElement;
  readonly #localVersion: HTMLElement;
  readonly #cloudVersion: HTMLElement;
  readonly #uploadButton: HTMLButtonElement;
  readonly #pullButton: HTMLButtonElement;
  readonly #toast: HTMLElement;
  readonly #dialog: HTMLDialogElement;
  readonly #dialogTitle: HTMLElement;
  readonly #dialogMessage: HTMLElement;
  readonly #dialogActions: HTMLElement;
  readonly #listeners: Array<() => void> = [];
  #runtime: ModuleSyncUiRuntime | null = null;
  #snapshot = EMPTY_SNAPSHOT;
  #localSaveFailed = false;
  #busy = false;
  #disposed = false;
  #toastTimer: number | null = null;
  #dialogResolve: ((confirmed: boolean) => void) | null = null;
  #lastState = "loading";

  constructor(options: ModuleSyncUiOptions) {
    this.#mount = options.mount;
    this.#guardAction = options.guardAction;
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
    state.textContent = "正在读取状态…";
    heading.append(dot, state);

    const versions = document.createElement("div");
    versions.className = "shared-module-sync-versions";
    const localVersion = document.createElement("span");
    localVersion.textContent = "本地：读取中";
    const cloudVersion = document.createElement("span");
    cloudVersion.textContent = "云端：读取中";
    versions.append(localVersion, cloudVersion);
    summary.append(heading, versions);

    const actions = document.createElement("div");
    actions.className = "shared-module-sync-actions";
    const uploadButton = createButton(
      document,
      "上传",
      "将本模块的本地完整数据上传到云端",
      "upload",
      UploadOne,
    );
    const pullButton = createButton(
      document,
      "拉取",
      "用本模块的云端完整数据更新本机",
      "pull",
      DownloadOne,
    );
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
    this.#uploadButton = uploadButton;
    this.#pullButton = pullButton;
    this.#toast = toast;
    this.#dialog = dialog;
    this.#dialogTitle = dialogTitle;
    this.#dialogMessage = dialogMessage;
    this.#dialogActions = dialogActions;

    this.#listen(uploadButton, "click", () => {
      void this.#runAction("upload");
    });
    this.#listen(pullButton, "click", () => {
      void this.#runAction("pull");
    });
    this.#listen(dialog, "cancel", (event) => {
      event.preventDefault();
      this.#resolveDialog(false);
    });
    this.#render();
  }

  attachRuntime(runtime: ModuleSyncUiRuntime): void {
    this.#assertAlive();
    this.#runtime = runtime;
    this.#snapshot = runtime.getSnapshot();
    this.#render();
  }

  renderSnapshot(snapshot: SyncCoordinatorSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = snapshot;
    if (!snapshot.sessionDirty && this.#localSaveFailed) {
      this.#setLocalSaveFailed(false);
    }
    this.#render();
  }

  setLocalSaveFailed(failed: boolean): void {
    if (this.#disposed) return;
    this.#setLocalSaveFailed(failed);
    this.#render();
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
    this.#runtime = null;
    this.#mount.replaceChildren();
  }

  async #runAction(action: ModuleSyncAction): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || this.#busy || this.#disposed) return;
    this.#busy = true;
    this.#render();
    try {
      const gate = await this.#guardAction(action);
      if (gate.status === "blocked") {
        this.#showMessage(gate.message);
        return;
      }
      if (action === "upload") {
        await this.#upload(runtime);
      } else {
        await this.#pull(runtime);
      }
    } catch {
      this.#showMessage(
        action === "pull"
          ? "拉取失败；本机内容没有被覆盖。"
          : "上传失败；本机内容仍然保留。",
        "error",
      );
    } finally {
      this.#busy = false;
      this.#render();
    }
  }

  async #upload(runtime: ModuleSyncUiRuntime): Promise<void> {
    let result: SyncActionResult;
    let localWinsConfirmed = false;
    if (runtime.getSnapshot().conflict) {
      if (!await this.#confirmLocalWins()) return;
      localWinsConfirmed = true;
      result = await runtime.resolveConflict("local-wins");
    } else {
      result = await runtime.upload();
    }
    if (result === "conflict" && !localWinsConfirmed) {
      if (!await this.#confirmLocalWins()) return;
      result = await runtime.resolveConflict("local-wins");
    }
    if (result === "conflict") {
      this.#showMessage(
        "覆盖期间云端再次变化，请检查版本后重试。",
        "error",
      );
      return;
    }
    this.#setLocalSaveFailed(false);
    this.#showMessage(
      result === "unchanged"
        ? "云端内容已经是最新版本。"
        : "已上传到云端。",
      "success",
    );
  }

  async #pull(runtime: ModuleSyncUiRuntime): Promise<void> {
    const snapshot = runtime.getSnapshot();
    const needsChoice = Boolean(
      snapshot.conflict
      || snapshot.sessionDirty
      || snapshot.localChangedSinceSync,
    );
    if (needsChoice) {
      if (!await this.#confirmCloudWins()) return;
      await runtime.resolveConflict("cloud-wins");
      this.#setLocalSaveFailed(false);
      return;
    }
    const result = await runtime.pull();
    if (result === "conflict") {
      if (!await this.#confirmCloudWins()) return;
      await runtime.resolveConflict("cloud-wins");
      this.#setLocalSaveFailed(false);
    } else if (result === "unchanged") {
      this.#showMessage("本机已经是已知的最新云端版本。");
    }
  }

  #confirmLocalWins(): Promise<boolean> {
    return this.#confirm(
      "用本地版本覆盖云端？",
      "本地和云端都已变化。继续会以本模块的本地完整数据覆盖云端。",
      "本地覆盖云端",
    );
  }

  #confirmCloudWins(): Promise<boolean> {
    return this.#confirm(
      "用云端版本覆盖本地？",
      "继续会丢弃本模块尚未上传的本地变化，并以云端完整数据替换本机。",
      "云端覆盖本地",
    );
  }

  #confirm(
    title: string,
    message: string,
    confirmLabel: string,
  ): Promise<boolean> {
    this.#resolveDialog(false);
    this.#dialogTitle.textContent = title;
    this.#dialogMessage.textContent = message;
    const document = this.#dialog.ownerDocument;
    const confirmButton = createDialogButton(
      document,
      confirmLabel,
      "danger",
    );
    const cancelButton = createDialogButton(document, "取消", "neutral");
    this.#dialogActions.replaceChildren(confirmButton, cancelButton);
    return new Promise((resolve) => {
      this.#dialogResolve = resolve;
      confirmButton.addEventListener("click", () => this.#resolveDialog(true));
      cancelButton.addEventListener("click", () => this.#resolveDialog(false));
      this.#dialog.showModal();
    });
  }

  #resolveDialog(confirmed: boolean): void {
    const resolve = this.#dialogResolve;
    if (!resolve) return;
    this.#dialogResolve = null;
    if (this.#dialog.open) this.#dialog.close();
    resolve(confirmed);
  }

  #setLocalSaveFailed(failed: boolean): void {
    if (this.#localSaveFailed === failed) return;
    this.#localSaveFailed = failed;
  }

  #render(): void {
    const snapshot = this.#snapshot;
    const runtimeReady = this.#runtime !== null;
    if (!snapshot.initialized) {
      this.#region.dataset.state = "loading";
      this.#state.textContent = "正在读取状态…";
      this.#localVersion.textContent = "本地：读取中";
      this.#cloudVersion.textContent = "云端：读取中";
      this.#localVersion.title = "";
      this.#cloudVersion.title = "";
      this.#region.title = "正在读取本地与云端版本状态。";
    } else {
      const localBase = snapshot.localSavedAt
        ? `本地：${formatTimestamp(snapshot.localSavedAt)}`
        : "本地：时间未知";
      const unsaved = snapshot.sessionDirty && this.#localSaveFailed;
      this.#localVersion.textContent = unsaved
        ? `${localBase}（有未保存修改）`
        : localBase;
      this.#localVersion.title = snapshot.localSavedAt ?? "";
      this.#cloudVersion.textContent = snapshot.knownRemoteUpdatedAt
        ? `云端：${formatTimestamp(snapshot.knownRemoteUpdatedAt)}`
        : snapshot.knownRemoteRevision
          ? "云端：时间未知"
          : "云端：尚无版本";
      this.#cloudVersion.title = snapshot.knownRemoteUpdatedAt ?? "";

      const state = snapshot.conflict
        ? "conflict"
        : snapshot.pendingUpload
          ? "pending"
          : unsaved
            ? "unsaved"
            : snapshot.localChangedSinceSync
              ? "local-ahead"
              : "synced";
      const stateCopy = {
        conflict: "本地与云端冲突",
        pending: "上传结果待确认",
        unsaved: "尚未保存到本机",
        "local-ahead": "本地修改尚未上传",
        synced: "本地与云端一致",
      } as const;
      const stateTitle = {
        conflict: "本地与云端都已变化，请通过上传或拉取选择保留方向。",
        pending: "上传结果尚未确认，Shared 会在后续同步时继续核验。",
        unsaved: "自动保存失败，当前页面内容仍然保留。",
        "local-ahead": "本地修改已经保存，尚未上传。",
        synced: "本地与云端一致。",
      } as const;
      this.#region.dataset.state = state;
      this.#state.textContent = stateCopy[state];
      this.#region.title = stateTitle[state];
      if (state === "conflict" && this.#lastState !== "conflict") {
        this.#showMessage(
          "本地与云端都已变化，请通过上传或拉取选择保留方向。",
          "error",
          6200,
        );
      }
      this.#lastState = state;
    }
    const disabled = !runtimeReady || this.#busy;
    this.#uploadButton.disabled = disabled;
    this.#pullButton.disabled = disabled;
  }

  #showMessage(
    message: string,
    tone: "normal" | "success" | "error" = "normal",
    duration = 4200,
  ): void {
    const pageWindow = this.#mount.ownerDocument.defaultView;
    if (this.#toastTimer !== null) {
      pageWindow?.clearTimeout(this.#toastTimer);
    }
    this.#toast.textContent = message;
    this.#toast.dataset.tone = tone;
    this.#toast.hidden = false;
    this.#toastTimer = pageWindow?.setTimeout(() => {
      this.#toast.hidden = true;
      this.#toastTimer = null;
    }, duration) ?? null;
  }

  #listen(
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
  ): void {
    target.addEventListener(type, listener);
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("Module sync UI is disposed.");
  }
}

function createButton(
  document: Document,
  label: string,
  title: string,
  action: ModuleSyncAction,
  icon: IconRenderer,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "shared-module-sync-button";
  button.dataset.action = action;
  button.append(createIcon(document, icon));
  button.setAttribute("aria-label", label);
  button.title = title;
  return button;
}

type IconRenderer = typeof UploadOne;

function createIcon(
  document: Document,
  renderer: IconRenderer,
): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = renderer({
    size: 20,
    strokeWidth: 3,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    theme: "outline",
    fill: "currentColor",
  }).replace(/^<\?xml[^>]*>\s*/u, "");
  const icon = template.content.querySelector("svg");
  if (!icon) throw new Error("IconPark did not return an SVG element.");
  icon.classList.add("shared-module-sync-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  return icon;
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

let dialogSequence = 0;

function nextDialogId(): number {
  dialogSequence += 1;
  return dialogSequence;
}
