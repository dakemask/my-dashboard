export type PersistenceOperationKind = "local" | "cloud";

export interface OperationGatePresentation {
  begin(kind: PersistenceOperationKind): void;
  end(kind: PersistenceOperationKind): void;
}

const NO_PRESENTATION: OperationGatePresentation = {
  begin: () => undefined,
  end: () => undefined,
};

/** Serializes all persistence work and brackets only the currently running job. */
export class OperationGate {
  readonly #presentation: OperationGatePresentation;
  #tail: Promise<void> = Promise.resolve();
  #activeKind: PersistenceOperationKind | null = null;
  #queuedCount = 0;

  constructor(presentation: OperationGatePresentation = NO_PRESENTATION) {
    this.#presentation = presentation;
  }

  get activeKind(): PersistenceOperationKind | null {
    return this.#activeKind;
  }

  get busy(): boolean {
    return this.#activeKind !== null || this.#queuedCount > 0;
  }

  runLocal<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    return this.run("local", operation);
  }

  runCloud<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    return this.run("cloud", operation);
  }

  run<T>(
    kind: PersistenceOperationKind,
    operation: () => T | PromiseLike<T>,
  ): Promise<T> {
    this.#queuedCount += 1;
    const execute = async (): Promise<T> => {
      this.#queuedCount -= 1;
      this.#activeKind = kind;
      let presentationEntered = false;
      try {
        presentationEntered = true;
        this.#presentation.begin(kind);
        return await operation();
      } finally {
        try {
          if (presentationEntered) {
            this.#presentation.end(kind);
          }
        } finally {
          this.#activeKind = null;
        }
      }
    };

    const result = this.#tail.then(execute, execute);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once all operations queued at call time have settled. */
  whenIdle(): Promise<void> {
    return this.#tail;
  }
}
