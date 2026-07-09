import type { PrivateDataSettings } from "../shared/privateData/types";
import { normalizePath } from "./mindMapLibrary";
import type { MindMapWorkspaceSnapshot, MindMapWorkspaceStoredSnapshot } from "./mindMapWorkspace";

export interface MindMapLocalSnapshot extends MindMapWorkspaceStoredSnapshot {
  id: string;
  rootPath: string;
  updatedAt: number;
}

const DB_NAME = "my-dashboard-mind-map";
const DB_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";

export function getMindMapLocalCacheKey(settings: PrivateDataSettings): string {
  return [
    settings.owner.trim(),
    settings.repo.trim(),
    settings.branch.trim(),
    normalizePath(settings.path),
  ].join("|");
}

export async function loadMindMapLocalSnapshot(
  settings: PrivateDataSettings,
): Promise<MindMapLocalSnapshot | null> {
  const db = await openDatabase();
  const snapshot = await requestToPromise<MindMapLocalSnapshot | undefined>(
    db.transaction(SNAPSHOT_STORE, "readonly").objectStore(SNAPSHOT_STORE).get(getMindMapLocalCacheKey(settings)),
  );

  db.close();
  return snapshot ?? null;
}

export async function saveMindMapLocalSnapshot(
  settings: PrivateDataSettings,
  snapshot: MindMapWorkspaceSnapshot & {
    rootPath: string;
    updatedAt: number;
  },
): Promise<void> {
  const db = await openDatabase();
  const value: MindMapLocalSnapshot = {
    ...snapshot,
    id: getMindMapLocalCacheKey(settings),
  };

  await requestToPromise(db.transaction(SNAPSHOT_STORE, "readwrite").objectStore(SNAPSHOT_STORE).put(value));
  db.close();
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, {
          keyPath: "id",
        });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}
