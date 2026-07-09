import { loadJsonFileAtPath, saveJsonFileAtPath } from "./jsonFileRepository";
import type { PrivateDataSettings } from "./types";

export interface PrivateDataRevision {
  revision: string;
  updatedAt: string;
}

export interface LoadedPrivateDataRevision {
  data: PrivateDataRevision;
  sha: string;
}

export interface PrivateDataRevisionPoller {
  start: (options?: { immediate?: boolean }) => void;
  stop: () => void;
  restart: (options?: { immediate?: boolean }) => void;
}

interface PrivateDataRevisionPollerOptions {
  getSettings: () => PrivateDataSettings | null;
  getModuleRoot: (settings: PrivateDataSettings) => string;
  getKnownRevision: () => string | null;
  onRevisionChange: (revision: LoadedPrivateDataRevision) => Promise<void> | void;
  onError: (error: unknown) => void;
}

const REVISION_FILE_NAME = "revision.json";
const FOREGROUND_POLL_INTERVAL_MS = 60 * 1000;
const FOREGROUND_POLL_JITTER_MS = 15 * 1000;
const BACKGROUND_POLL_INTERVAL_MS = 5 * 60 * 1000;
const BACKGROUND_POLL_JITTER_MS = 60 * 1000;

export function getPrivateDataRevisionFileName(): string {
  return REVISION_FILE_NAME;
}

export function getPrivateDataRevisionPath(moduleRoot: string): string {
  return joinPrivateDataPath(moduleRoot, REVISION_FILE_NAME);
}

export function getPrivateDataFileParentPath(filePath: string): string {
  const normalized = normalizePrivateDataPath(filePath);
  const index = normalized.lastIndexOf("/");

  return index === -1 ? "" : normalized.slice(0, index);
}

export async function loadPrivateDataRevision(
  settings: PrivateDataSettings,
  moduleRoot: string,
): Promise<LoadedPrivateDataRevision | null> {
  const result = await loadJsonFileAtPath(
    settings,
    getPrivateDataRevisionPath(moduleRoot),
    normalizePrivateDataRevision,
    createEmptyPrivateDataRevision,
  );

  if (result.created || !result.sha) {
    return null;
  }

  return {
    data: result.data,
    sha: result.sha,
  };
}

export async function savePrivateDataRevision(
  settings: PrivateDataSettings,
  moduleRoot: string,
  message = `update ${normalizePrivateDataPath(moduleRoot)} revision`,
  currentSha?: string | null,
): Promise<LoadedPrivateDataRevision> {
  const shaToUpdate = currentSha === undefined ? (await loadPrivateDataRevision(settings, moduleRoot))?.sha ?? null : currentSha;
  const data = createPrivateDataRevision();
  const sha = await saveJsonFileAtPath(settings, getPrivateDataRevisionPath(moduleRoot), data, shaToUpdate, message);

  return {
    data,
    sha,
  };
}

export function createPrivateDataRevisionPoller(
  options: PrivateDataRevisionPollerOptions,
): PrivateDataRevisionPoller {
  let stopped = true;
  let inFlight = false;
  let timeoutId: number | null = null;

  const handleVisibilityChange = (): void => {
    if (stopped) {
      return;
    }

    scheduleNextPoll(document.hidden ? undefined : 0);
  };

  function start(options: { immediate?: boolean } = {}): void {
    if (!stopped) {
      return;
    }

    stopped = false;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleNextPoll(options.immediate === false ? undefined : 0);
  }

  function stop(): void {
    if (stopped) {
      return;
    }

    stopped = true;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    clearPendingPoll();
  }

  function restart(options: { immediate?: boolean } = {}): void {
    stop();
    start(options);
  }

  function scheduleNextPoll(delayMs = getNextPollDelayMs()): void {
    clearPendingPoll();

    if (stopped) {
      return;
    }

    timeoutId = window.setTimeout(() => {
      void pollRevision();
    }, delayMs);
  }

  function clearPendingPoll(): void {
    if (timeoutId === null) {
      return;
    }

    window.clearTimeout(timeoutId);
    timeoutId = null;
  }

  async function pollRevision(): Promise<void> {
    if (stopped) {
      return;
    }

    if (inFlight) {
      scheduleNextPoll();
      return;
    }

    inFlight = true;

    try {
      const settings = options.getSettings();

      if (settings) {
        const revision = await loadPrivateDataRevision(settings, options.getModuleRoot(settings));

        if (revision && revision.data.revision && revision.data.revision !== options.getKnownRevision()) {
          await options.onRevisionChange(revision);
        }
      }
    } catch (error) {
      options.onError(error);
    } finally {
      inFlight = false;
      scheduleNextPoll();
    }
  }

  return {
    start,
    stop,
    restart,
  };
}

function getNextPollDelayMs(): number {
  if (document.hidden) {
    return BACKGROUND_POLL_INTERVAL_MS + Math.round(Math.random() * BACKGROUND_POLL_JITTER_MS);
  }

  return FOREGROUND_POLL_INTERVAL_MS + Math.round(Math.random() * FOREGROUND_POLL_JITTER_MS);
}

function createPrivateDataRevision(): PrivateDataRevision {
  const updatedAt = new Date().toISOString();

  return {
    revision: `${updatedAt}-${crypto.randomUUID()}`,
    updatedAt,
  };
}

function createEmptyPrivateDataRevision(): PrivateDataRevision {
  return {
    revision: "",
    updatedAt: "",
  };
}

function normalizePrivateDataRevision(value: unknown): PrivateDataRevision {
  if (!value || typeof value !== "object") {
    return createEmptyPrivateDataRevision();
  }

  const record = value as Record<string, unknown>;

  return {
    revision: typeof record.revision === "string" ? record.revision : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

function joinPrivateDataPath(...parts: string[]): string {
  return normalizePrivateDataPath(parts.filter(Boolean).join("/"));
}

function normalizePrivateDataPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}
