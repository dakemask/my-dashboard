export const DEFAULT_HISTORY_LIMIT = 100;

export interface StagingHistoryOptions<T> {
  readonly maxVersions?: number;
  /** A deterministic, collision-resistant key for the payload's semantic content. */
  readonly contentKey: (payload: T) => string;
}

interface Version<T> {
  readonly payload: T;
  readonly key: string;
}

/**
 * An in-memory, page-lifetime history of immutable full-module payloads.
 * System metadata deliberately lives outside this history.
 */
export class StagingHistory<T> {
  readonly #maxVersions: number;
  readonly #contentKey: (payload: T) => string;
  #versions: Version<T>[];
  #position = 0;
  #savedBaselineKey: string;

  constructor(initialPayload: T, options: StagingHistoryOptions<T>) {
    if (typeof options?.contentKey !== "function") {
      throw new TypeError("A payload contentKey function is required.");
    }
    const maxVersions = options.maxVersions ?? DEFAULT_HISTORY_LIMIT;
    if (!Number.isInteger(maxVersions) || maxVersions < 1) {
      throw new RangeError("maxVersions must be a positive integer.");
    }

    this.#maxVersions = maxVersions;
    this.#contentKey = options.contentKey;
    const initial = this.#makeVersion(initialPayload);
    this.#versions = [initial];
    this.#savedBaselineKey = initial.key;
  }

  get current(): T {
    return structuredClone(this.#versions[this.#position]!.payload);
  }

  get canUndo(): boolean {
    return this.#position > 0;
  }

  get canRedo(): boolean {
    return this.#position < this.#versions.length - 1;
  }

  get dirty(): boolean {
    return this.#versions[this.#position]!.key !== this.#savedBaselineKey;
  }

  get size(): number {
    return this.#versions.length;
  }

  /**
   * Adds one complete payload version. Equal payloads are a no-op and do not
   * destroy an existing redo branch.
   */
  commit(payload: T): T {
    const version = this.#makeVersion(payload);
    if (version.key === this.#versions[this.#position]!.key) {
      return this.current;
    }

    this.#versions.splice(this.#position + 1, Infinity, version);
    this.#position = this.#versions.length - 1;

    const excess = this.#versions.length - this.#maxVersions;
    if (excess > 0) {
      this.#versions.splice(0, excess);
      this.#position -= excess;
    }

    return this.current;
  }

  undo(): T {
    if (this.canUndo) {
      this.#position -= 1;
    }
    return this.current;
  }

  redo(): T {
    if (this.canRedo) {
      this.#position += 1;
    }
    return this.current;
  }

  /** Marks the current payload as the successfully persisted local baseline. */
  markSaved(): void {
    this.#savedBaselineKey = this.#versions[this.#position]!.key;
  }

  /**
   * Updates the local baseline without altering the version queue. This is
   * useful when a caller already knows the payload committed by an atomic save.
   */
  updateBaseline(payload?: T): void {
    if (arguments.length === 0) {
      this.#savedBaselineKey = this.#versions[this.#position]!.key;
      return;
    }

    const snapshot = structuredClone(payload as T);
    this.#savedBaselineKey = this.#getContentKey(snapshot);
  }

  #makeVersion(payload: T): Version<T> {
    const snapshot = structuredClone(payload);
    return Object.freeze({ payload: snapshot, key: this.#getContentKey(snapshot) });
  }

  #getContentKey(payload: T): string {
    const key = this.#contentKey(structuredClone(payload));
    if (typeof key !== "string") {
      throw new TypeError("contentKey must return a string.");
    }
    return key;
  }
}
