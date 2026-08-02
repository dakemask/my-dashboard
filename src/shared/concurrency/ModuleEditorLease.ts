import { isModuleId, isProfileId } from "../identifiers";

export type ModuleEditorLeaseStatus =
  | "idle"
  | "acquiring"
  | "acquired"
  | "blocked"
  | "unsupported"
  | "released";

export interface ModuleEditorLeaseOptions {
  /** `undefined` auto-detects navigator.locks; `null` explicitly disables it. */
  readonly lockManager?: LockManager | null;
  readonly profileId?: string;
}

const LOCK_PREFIX = "my-dashboard.module.";
const LOCK_SUFFIX = ".editor";

/** Holds one non-waiting, exclusive Web Lock for the lifetime of an editor. */
export class ModuleEditorLease {
  readonly moduleId: string;
  readonly lockName: string;
  readonly #lockManager: LockManager | null;
  #status: ModuleEditorLeaseStatus = "idle";
  #acquirePromise: Promise<ModuleEditorLeaseStatus> | null = null;
  #requestPromise: Promise<void> | null = null;
  #releaseLock: (() => void) | null = null;
  #requestError: unknown = null;

  constructor(moduleId: string, options: ModuleEditorLeaseOptions = {}) {
    if (!isModuleId(moduleId)) {
      throw new TypeError(`Invalid moduleId: ${moduleId}`);
    }

    const profileId = options.profileId;
    if (profileId !== undefined && !isProfileId(profileId)) {
      throw new TypeError(`Invalid profileId: ${profileId}`);
    }

    this.moduleId = moduleId;
    this.lockName = profileId === undefined
      ? `${LOCK_PREFIX}${moduleId}${LOCK_SUFFIX}`
      : `${LOCK_PREFIX}${profileId}.${moduleId}${LOCK_SUFFIX}`;
    this.#lockManager =
      options.lockManager === undefined
        ? (globalThis.navigator?.locks ?? null)
        : options.lockManager;
  }

  get status(): ModuleEditorLeaseStatus {
    return this.#status;
  }

  get editable(): boolean {
    return this.#status === "acquired";
  }

  acquire(): Promise<ModuleEditorLeaseStatus> {
    if (this.#acquirePromise !== null) {
      return this.#acquirePromise;
    }

    if (this.#status !== "idle") {
      return Promise.resolve(this.#status);
    }

    if (this.#lockManager === null) {
      this.#status = "unsupported";
      this.#acquirePromise = Promise.resolve(this.#status);
      return this.#acquirePromise;
    }

    this.#status = "acquiring";
    this.#acquirePromise = new Promise<ModuleEditorLeaseStatus>((resolve, reject) => {
      let resultSettled = false;
      const settleResult = (status: ModuleEditorLeaseStatus): void => {
        if (!resultSettled) {
          resultSettled = true;
          resolve(status);
        }
      };

      try {
        this.#requestPromise = this.#lockManager!
          .request(
            this.lockName,
            { mode: "exclusive", ifAvailable: true },
            async (lock) => {
              if (lock === null) {
                this.#status = "blocked";
                settleResult(this.#status);
                return;
              }

              this.#status = "acquired";
              settleResult(this.#status);
              await new Promise<void>((release) => {
                this.#releaseLock = release;
              });
              this.#releaseLock = null;
              this.#status = "released";
            },
          )
          .then(() => undefined);
        void this.#requestPromise.catch((error: unknown) => {
          this.#requestError = error;
          if (!resultSettled) {
            resultSettled = true;
            reject(error);
          }
        });
      } catch (error) {
        this.#requestError = error;
        resultSettled = true;
        reject(error);
      }
    });

    return this.#acquirePromise;
  }

  async release(): Promise<void> {
    if (this.#status === "acquiring") {
      await this.acquire();
    }

    if (this.#status === "acquired") {
      this.#releaseLock?.();
      await this.#requestPromise;
    }

    if (this.#requestError !== null) {
      throw this.#requestError;
    }
  }
}
