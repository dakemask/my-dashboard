import type { SyncCoordinatorSnapshot } from "../sync";
import {
  executeModuleSyncAction,
  type ModuleSyncAction,
  type ModuleSyncGateResult,
  type ModuleSyncUiRuntime,
} from "./moduleSyncActions";
import { ModuleSyncView } from "./moduleSyncView";
import {
  createModuleSyncViewModel,
  EMPTY_SYNC_SNAPSHOT,
  type ModuleSyncViewState,
} from "./moduleSyncViewModel";

export type {
  ModuleSyncAction,
  ModuleSyncGateResult,
  ModuleSyncUiRuntime,
} from "./moduleSyncActions";

export interface ModuleSyncUiOptions {
  readonly mount: HTMLElement;
  readonly guardAction: (
    action: ModuleSyncAction,
  ) => ModuleSyncGateResult | Promise<ModuleSyncGateResult>;
}

/**
 * Stable Shared facade for manual cloud synchronization. Command decisions,
 * pure state projection, and DOM rendering live in separate internal modules.
 */
export class ModuleSyncUi {
  readonly #guardAction: ModuleSyncUiOptions["guardAction"];
  readonly #view: ModuleSyncView;
  #runtime: ModuleSyncUiRuntime | null = null;
  #snapshot = EMPTY_SYNC_SNAPSHOT;
  #localSaveFailed = false;
  #busy = false;
  #busyAction: ModuleSyncAction | null = null;
  #disposed = false;
  #lastState: ModuleSyncViewState = "loading";

  constructor(options: ModuleSyncUiOptions) {
    this.#guardAction = options.guardAction;
    this.#view = new ModuleSyncView({
      mount: options.mount,
      onAction: (action) => {
        void this.#runAction(action);
      },
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
      this.#localSaveFailed = false;
    }
    this.#render();
  }

  setLocalSaveFailed(failed: boolean): void {
    if (this.#disposed) return;
    this.#localSaveFailed = failed;
    this.#render();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#runtime = null;
    this.#view.dispose();
  }

  async #runAction(action: ModuleSyncAction): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime || this.#busy || this.#disposed) return;
    this.#busy = true;
    this.#busyAction = action;
    this.#render();
    try {
      await executeModuleSyncAction(
        action,
        runtime,
        this.#guardAction,
        {
          confirmLocalWins: () => this.#view.confirmLocalWins(),
          confirmCloudWins: () => this.#view.confirmCloudWins(),
          setLocalSaveFailed: (failed) => {
            this.#localSaveFailed = failed;
          },
          showMessage: (message, tone, duration) => {
            this.#view.showMessage(message, tone, duration);
          },
        },
      );
    } finally {
      this.#busy = false;
      this.#busyAction = null;
      this.#render();
    }
  }

  #render(): void {
    if (this.#disposed) return;
    const model = createModuleSyncViewModel(this.#snapshot, {
      mode: this.#runtime?.mode ?? null,
      runtimeReady: this.#runtime !== null,
      busy: this.#busy,
      busyAction: this.#busyAction,
      localSaveFailed: this.#localSaveFailed,
    });
    this.#view.render(model);
    if (model.state === "conflict" && this.#lastState !== "conflict") {
      this.#view.showMessage(
        "本地与云端都已变化，请通过上传或拉取选择保留方向。",
        "error",
      );
    }
    this.#lastState = model.state;
  }

  #assertAlive(): void {
    if (this.#disposed) throw new Error("Module sync UI is disposed.");
  }
}
