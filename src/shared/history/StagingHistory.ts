export type HistoryCapacity = number | "unlimited";

/**
 * Describes how one module event changes a payload and how that event can be
 * reversed. Events, rather than payload snapshots, are retained in history.
 */
export interface ModuleHistoryPolicy<TPayload, TEvent> {
  /** Maximum number of events retained, or no limit. */
  readonly capacity: HistoryCapacity;
  /** Applies an event to a payload and returns the resulting payload. */
  readonly apply: (payload: TPayload, event: TEvent) => TPayload;
  /** Creates the event that reverses `event` from `after` back to `before`. */
  readonly invert: (
    event: TEvent,
    before: TPayload,
    after: TPayload,
  ) => TEvent;
}

export interface StagingHistoryOptions<TPayload, TEvent> {
  /** A deterministic, collision-resistant key for the payload's semantic content. */
  readonly contentKey: (payload: TPayload) => string;
  readonly policy: ModuleHistoryPolicy<TPayload, TEvent>;
}

interface HistoryEntry<TEvent> {
  readonly forward: TEvent;
  readonly inverse: TEvent;
  readonly beforeKey: string;
  readonly afterKey: string;
}

/**
 * Page-lifetime module history backed by one current payload plus reversible
 * events. System metadata deliberately lives outside this history.
 */
export class StagingHistory<TPayload, TEvent> {
  readonly #capacity: HistoryCapacity;
  readonly #contentKey: (payload: TPayload) => string;
  readonly #apply: (payload: TPayload, event: TEvent) => TPayload;
  readonly #invert: (
    event: TEvent,
    before: TPayload,
    after: TPayload,
  ) => TEvent;
  #entries: HistoryEntry<TEvent>[] = [];
  #position = 0;
  #current: TPayload;
  #currentKey: string;
  #savedBaselineKey: string;

  constructor(
    initialPayload: TPayload,
    options: StagingHistoryOptions<TPayload, TEvent>,
  ) {
    if (typeof options?.contentKey !== "function") {
      throw new TypeError("A payload contentKey function is required.");
    }
    if (typeof options?.policy?.apply !== "function") {
      throw new TypeError("A history apply function is required.");
    }
    if (typeof options?.policy?.invert !== "function") {
      throw new TypeError("A history invert function is required.");
    }
    const capacity = options.policy.capacity;
    if (
      capacity !== "unlimited"
      && (!Number.isInteger(capacity) || capacity < 1)
    ) {
      throw new RangeError(
        'History capacity must be a positive integer or "unlimited".',
      );
    }

    this.#capacity = capacity;
    this.#contentKey = options.contentKey;
    this.#apply = options.policy.apply;
    this.#invert = options.policy.invert;
    this.#current = structuredClone(initialPayload);
    this.#currentKey = this.#getContentKey(this.#current);
    this.#savedBaselineKey = this.#currentKey;
  }

  get current(): TPayload {
    return structuredClone(this.#current);
  }

  get canUndo(): boolean {
    return this.#position > 0;
  }

  get canRedo(): boolean {
    return this.#position < this.#entries.length;
  }

  get dirty(): boolean {
    return this.#currentKey !== this.#savedBaselineKey;
  }

  /** Number of retained forward/inverse event pairs. */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Applies and records one module event. A semantic no-op is not recorded and
   * preserves an existing redo branch. A real event replaces the redo branch.
   */
  dispatch(event: TEvent): TPayload {
    const before = structuredClone(this.#current);
    const forward = structuredClone(event);
    const after = this.#applyEvent(before, forward);
    const afterKey = this.#getContentKey(after);

    if (afterKey === this.#currentKey) {
      return this.current;
    }

    const inverse = structuredClone(
      this.#invert(
        structuredClone(forward),
        structuredClone(before),
        structuredClone(after),
      ),
    );
    const entry: HistoryEntry<TEvent> = Object.freeze({
      forward: structuredClone(forward),
      inverse,
      beforeKey: this.#currentKey,
      afterKey,
    });

    // No state changes occur until apply, contentKey, invert and every required
    // clone have succeeded, keeping a failed dispatch completely atomic.
    const nextEntries = this.#entries.slice(0, this.#position);
    nextEntries.push(entry);
    let nextPosition = this.#position + 1;

    if (this.#capacity !== "unlimited") {
      const excess = nextEntries.length - this.#capacity;
      if (excess > 0) {
        nextEntries.splice(0, excess);
        nextPosition -= excess;
      }
    }

    this.#entries = nextEntries;
    this.#position = nextPosition;
    this.#current = after;
    this.#currentKey = afterKey;
    return this.current;
  }

  undo(): TPayload {
    if (!this.canUndo) {
      return this.current;
    }

    const entry = this.#entries[this.#position - 1]!;
    if (this.#currentKey !== entry.afterKey) {
      throw new Error(
        "Cannot undo because the current payload does not match the event's after state.",
      );
    }
    const next = this.#applyEvent(this.#current, entry.inverse);
    const nextKey = this.#getContentKey(next);
    if (nextKey !== entry.beforeKey) {
      throw new Error(
        "Cannot undo because the inverse event did not restore its before state.",
      );
    }

    this.#current = next;
    this.#currentKey = nextKey;
    this.#position -= 1;
    return this.current;
  }

  redo(): TPayload {
    if (!this.canRedo) {
      return this.current;
    }

    const entry = this.#entries[this.#position]!;
    if (this.#currentKey !== entry.beforeKey) {
      throw new Error(
        "Cannot redo because the current payload does not match the event's before state.",
      );
    }
    const next = this.#applyEvent(this.#current, entry.forward);
    const nextKey = this.#getContentKey(next);
    if (nextKey !== entry.afterKey) {
      throw new Error(
        "Cannot redo because the forward event did not restore its after state.",
      );
    }

    this.#current = next;
    this.#currentKey = nextKey;
    this.#position += 1;
    return this.current;
  }

  /** Marks the current payload as the successfully persisted local baseline. */
  markSaved(): void {
    this.#savedBaselineKey = this.#currentKey;
  }

  /**
   * Updates the local baseline without altering the event queue. This is useful
   * when a caller already knows the payload committed by an atomic save.
   */
  updateBaseline(payload?: TPayload): void {
    if (arguments.length === 0) {
      this.#savedBaselineKey = this.#currentKey;
      return;
    }

    const snapshot = structuredClone(payload as TPayload);
    this.#savedBaselineKey = this.#getContentKey(snapshot);
  }

  #applyEvent(payload: TPayload, event: TEvent): TPayload {
    return structuredClone(
      this.#apply(structuredClone(payload), structuredClone(event)),
    );
  }

  #getContentKey(payload: TPayload): string {
    const key = this.#contentKey(structuredClone(payload));
    if (typeof key !== "string") {
      throw new TypeError("contentKey must return a string.");
    }
    return key;
  }
}
