import { createJsonSnapshot, jsonSnapshotKey } from "./jsonSnapshot";

export const DEFAULT_HISTORY_LIMIT = 100;

export interface StagingHistoryOptions {
  readonly maxVersions?: number;
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
  #versions: Version<T>[];
  #position = 0;
  #savedBaselineKey: string;

  constructor(initialPayload: T, options: StagingHistoryOptions = {}) {
    const maxVersions = options.maxVersions ?? DEFAULT_HISTORY_LIMIT;
    if (!Number.isInteger(maxVersions) || maxVersions < 1) {
      throw new RangeError("maxVersions must be a positive integer.");
    }

    const initial = this.#makeVersion(initialPayload);
    this.#maxVersions = maxVersions;
    this.#versions = [initial];
    this.#savedBaselineKey = initial.key;
  }

  get current(): T {
    return this.#versions[this.#position]!.payload;
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
  updateBaseline(payload: T = this.current): void {
    const snapshot = createJsonSnapshot(payload);
    this.#savedBaselineKey = jsonSnapshotKey(snapshot);
  }

  #makeVersion(payload: T): Version<T> {
    const snapshot = createJsonSnapshot(payload);
    return Object.freeze({ payload: snapshot, key: jsonSnapshotKey(snapshot) });
  }
}
