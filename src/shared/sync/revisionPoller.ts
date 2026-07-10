export interface RevisionPoller {
  start(options?: { immediate?: boolean }): void;
  stop(): void;
  pollNow(): Promise<void>;
}

interface RevisionPollerOptions {
  readRevision: (signal: AbortSignal) => Promise<string | null>;
  onRevision: (revision: string | null) => Promise<void> | void;
  onAuthenticationError?: (error: unknown) => void;
  isAuthenticationError?: (error: unknown) => boolean;
  document?: Document;
  window?: Window;
  random?: () => number;
}

const FOREGROUND_INTERVAL_MS = 60_000;
const FOREGROUND_JITTER_MS = 15_000;
const BACKGROUND_INTERVAL_MS = 5 * 60_000;
const BACKGROUND_JITTER_MS = 60_000;

export function createRevisionPoller(options: RevisionPollerOptions): RevisionPoller {
  const pageDocument = options.document ?? document;
  const pageWindow = options.window ?? window;
  const random = options.random ?? Math.random;
  let running = false;
  let inFlight: Promise<void> | null = null;
  let timer: number | null = null;
  let controller: AbortController | null = null;

  const schedule = (delay = getDelay()): void => {
    clearTimer();
    if (!running) {
      return;
    }

    timer = pageWindow.setTimeout(() => void pollNow(), delay);
  };

  const onVisibilityChange = (): void => {
    schedule();
  };

  const onOnline = (): void => schedule(0);

  function getDelay(): number {
    return pageDocument.hidden
      ? BACKGROUND_INTERVAL_MS + Math.round(random() * BACKGROUND_JITTER_MS)
      : FOREGROUND_INTERVAL_MS + Math.round(random() * FOREGROUND_JITTER_MS);
  }

  function clearTimer(): void {
    if (timer !== null) {
      pageWindow.clearTimeout(timer);
      timer = null;
    }
  }

  async function pollNow(): Promise<void> {
    if (!running || inFlight) {
      return inFlight ?? Promise.resolve();
    }

    clearTimer();
    controller = new AbortController();
    inFlight = (async () => {
      try {
        const revision = await options.readRevision(controller!.signal);
        await options.onRevision(revision);
      } catch (error) {
        if (options.isAuthenticationError?.(error)) {
          options.onAuthenticationError?.(error);
        }
      } finally {
        controller = null;
        inFlight = null;
        schedule();
      }
    })();

    return inFlight;
  }

  return {
    start(startOptions = {}): void {
      if (running) {
        return;
      }

      running = true;
      pageDocument.addEventListener("visibilitychange", onVisibilityChange);
      pageWindow.addEventListener("online", onOnline);
      schedule(startOptions.immediate === false ? undefined : 0);
    },

    stop(): void {
      if (!running) {
        return;
      }

      running = false;
      clearTimer();
      controller?.abort();
      pageDocument.removeEventListener("visibilitychange", onVisibilityChange);
      pageWindow.removeEventListener("online", onOnline);
    },

    pollNow,
  };
}
