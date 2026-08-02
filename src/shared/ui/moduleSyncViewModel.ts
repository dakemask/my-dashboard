import type { SyncCoordinatorSnapshot } from "../sync";
import type { ModuleSyncAction } from "./moduleSyncActions";

export type ModuleSyncViewState =
  | "loading"
  | "local"
  | "conflict"
  | "pending"
  | "unsaved"
  | "local-ahead"
  | "synced";

export interface ModuleSyncViewModelOptions {
  readonly mode: "local" | "account" | null;
  readonly runtimeReady: boolean;
  readonly busy: boolean;
  readonly busyAction: ModuleSyncAction | null;
  readonly localSaveFailed: boolean;
}

export interface ModuleSyncViewModel {
  readonly mode: "local" | "account" | null;
  readonly state: ModuleSyncViewState;
  readonly stateText: string;
  readonly localVersionText: string;
  readonly localVersionTitle: string;
  readonly cloudVersionText: string;
  readonly cloudVersionTitle: string;
  readonly regionTitle: string;
  readonly cloudVersionHidden: boolean;
  readonly actionsHidden: boolean;
  readonly actionsDisabled: boolean;
  readonly busy: boolean;
  readonly busyText: string | null;
}

export const EMPTY_SYNC_SNAPSHOT: SyncCoordinatorSnapshot = {
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

export function createModuleSyncViewModel(
  snapshot: SyncCoordinatorSnapshot,
  options: ModuleSyncViewModelOptions,
): ModuleSyncViewModel {
  const actionsDisabled = !options.runtimeReady || options.busy;
  if (!snapshot.initialized) {
    return {
      mode: options.mode,
      state: "loading",
      stateText: "正在读取状态…",
      localVersionText: "本地：读取中",
      localVersionTitle: "",
      cloudVersionText: "云端：读取中",
      cloudVersionTitle: "",
      regionTitle: "正在读取本地与云端版本状态。",
      cloudVersionHidden: false,
      actionsHidden: false,
      actionsDisabled,
      busy: options.busy,
      busyText: getBusyText(options.busyAction),
    };
  }

  const localBase = snapshot.localSavedAt
    ? `本地：${formatTimestamp(snapshot.localSavedAt)}`
    : "本地：时间未知";
  const unsaved = snapshot.sessionDirty && options.localSaveFailed;
  const localVersionText = unsaved
    ? `${localBase}（有未保存修改）`
    : localBase;
  const cloudVersionText = snapshot.knownRemoteUpdatedAt
    ? `云端：${formatTimestamp(snapshot.knownRemoteUpdatedAt)}`
    : snapshot.knownRemoteRevision
      ? "云端：时间未知"
      : "云端：尚无版本";

  if (options.mode === "local") {
    return {
      mode: options.mode,
      state: "local",
      stateText: unsaved ? "本地内容尚未保存" : "仅保存在本机",
      localVersionText,
      localVersionTitle: snapshot.localSavedAt ?? "",
      cloudVersionText,
      cloudVersionTitle: snapshot.knownRemoteUpdatedAt ?? "",
      regionTitle: "当前为本地模式，数据只保存在此浏览器。",
      cloudVersionHidden: true,
      actionsHidden: true,
      actionsDisabled: true,
      busy: options.busy,
      busyText: getBusyText(options.busyAction),
    };
  }

  const state: Exclude<ModuleSyncViewState, "loading" | "local"> =
    snapshot.conflict
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

  return {
    mode: options.mode,
    state,
    stateText: stateCopy[state],
    localVersionText,
    localVersionTitle: snapshot.localSavedAt ?? "",
    cloudVersionText,
    cloudVersionTitle: snapshot.knownRemoteUpdatedAt ?? "",
    regionTitle: stateTitle[state],
    cloudVersionHidden: false,
    actionsHidden: false,
    actionsDisabled,
    busy: options.busy,
    busyText: getBusyText(options.busyAction),
  };
}

function getBusyText(action: ModuleSyncAction | null): string | null {
  if (action === "upload") return "正在上传…";
  if (action === "pull") return "正在拉取…";
  return null;
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
