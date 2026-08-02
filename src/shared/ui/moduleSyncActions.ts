import type {
  ConflictResolution,
  SyncActionResult,
  SyncCoordinatorSnapshot,
} from "../sync";

export type ModuleSyncAction = "upload" | "pull";
export type ModuleSyncMessageTone = "normal" | "success" | "error";

export type ModuleSyncGateResult =
  | { readonly status: "ready" }
  | { readonly status: "blocked"; readonly message: string };

export interface ModuleSyncUiRuntime {
  readonly mode: "local" | "account";
  upload(): Promise<SyncActionResult>;
  pull(): Promise<SyncActionResult>;
  resolveConflict(strategy: ConflictResolution): Promise<SyncActionResult>;
  getSnapshot(): SyncCoordinatorSnapshot;
}

export interface ModuleSyncActionEffects {
  confirmLocalWins(): Promise<boolean>;
  confirmCloudWins(): Promise<boolean>;
  setLocalSaveFailed(failed: boolean): void;
  showMessage(
    message: string,
    tone?: ModuleSyncMessageTone,
    duration?: number,
  ): void;
}

export async function executeModuleSyncAction(
  action: ModuleSyncAction,
  runtime: ModuleSyncUiRuntime,
  guardAction: (
    action: ModuleSyncAction,
  ) => ModuleSyncGateResult | Promise<ModuleSyncGateResult>,
  effects: ModuleSyncActionEffects,
): Promise<void> {
  try {
    const gate = await guardAction(action);
    if (gate.status === "blocked") {
      effects.showMessage(gate.message);
      return;
    }

    if (action === "upload") {
      await upload(runtime, effects);
    } else {
      await pull(runtime, effects);
    }
  } catch {
    effects.showMessage(
      action === "pull"
        ? "拉取失败；本机内容没有被覆盖。"
        : "上传失败；本机内容仍然保留。",
      "error",
    );
  }
}

async function upload(
  runtime: ModuleSyncUiRuntime,
  effects: ModuleSyncActionEffects,
): Promise<void> {
  let result: SyncActionResult;
  let localWinsConfirmed = false;
  if (runtime.getSnapshot().conflict) {
    if (!await effects.confirmLocalWins()) return;
    localWinsConfirmed = true;
    result = await runtime.resolveConflict("local-wins");
  } else {
    result = await runtime.upload();
  }

  if (result === "conflict" && !localWinsConfirmed) {
    if (!await effects.confirmLocalWins()) return;
    result = await runtime.resolveConflict("local-wins");
  }
  if (result === "conflict") {
    effects.showMessage(
      "覆盖期间云端再次变化，请检查版本后重试。",
      "error",
    );
    return;
  }

  effects.setLocalSaveFailed(false);
  effects.showMessage(
    result === "unchanged"
      ? "云端内容已经是最新版本。"
      : "已上传到云端。",
    "success",
  );
}

async function pull(
  runtime: ModuleSyncUiRuntime,
  effects: ModuleSyncActionEffects,
): Promise<void> {
  const snapshot = runtime.getSnapshot();
  const needsChoice = Boolean(
    snapshot.conflict
    || snapshot.sessionDirty
    || snapshot.localChangedSinceSync,
  );
  if (needsChoice) {
    if (!await effects.confirmCloudWins()) return;
    await runtime.resolveConflict("cloud-wins");
    effects.setLocalSaveFailed(false);
    return;
  }

  const result = await runtime.pull();
  if (result === "conflict") {
    if (!await effects.confirmCloudWins()) return;
    await runtime.resolveConflict("cloud-wins");
    effects.setLocalSaveFailed(false);
  } else if (result === "unchanged") {
    effects.showMessage("本机已经是已知的最新云端版本。");
  }
}
