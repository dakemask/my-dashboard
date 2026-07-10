import { describe, expect, it, vi } from "vitest";

import {
  OperationGate,
  type OperationGatePresentation,
} from "../../src/shared/concurrency";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("OperationGate", () => {
  it("runs local and cloud persistence operations serially", async () => {
    const events: string[] = [];
    const presentation: OperationGatePresentation = {
      begin: (kind) => events.push(`begin:${kind}`),
      end: (kind) => events.push(`end:${kind}`),
    };
    const gate = new OperationGate(presentation);
    const firstWork = deferred<string>();

    const first = gate.runLocal(async () => {
      events.push("work:local");
      return firstWork.promise;
    });
    const second = gate.runCloud(() => {
      events.push("work:cloud");
      return "cloud-result";
    });
    await Promise.resolve();

    expect(events).toEqual(["begin:local", "work:local"]);
    expect(gate.activeKind).toBe("local");
    firstWork.resolve("local-result");

    await expect(first).resolves.toBe("local-result");
    await expect(second).resolves.toBe("cloud-result");
    expect(events).toEqual([
      "begin:local",
      "work:local",
      "end:local",
      "begin:cloud",
      "work:cloud",
      "end:cloud",
    ]);
    expect(gate.busy).toBe(false);
  });

  it("unblocks and continues the queue after an operation fails", async () => {
    const presentation: OperationGatePresentation = {
      begin: vi.fn(),
      end: vi.fn(),
    };
    const gate = new OperationGate(presentation);

    await expect(
      gate.runCloud(() => {
        throw new Error("network failed");
      }),
    ).rejects.toThrow("network failed");
    await expect(gate.runLocal(() => "retry succeeded")).resolves.toBe(
      "retry succeeded",
    );

    expect(presentation.end).toHaveBeenCalledWith("cloud");
    expect(presentation.end).toHaveBeenCalledWith("local");
    expect(gate.busy).toBe(false);
  });

  it("attempts presentation cleanup when begin fails partway through", async () => {
    let failBegin = true;
    const presentation: OperationGatePresentation = {
      begin: () => {
        if (failBegin) {
          throw new Error("presentation failed");
        }
      },
      end: vi.fn(),
    };
    const gate = new OperationGate(presentation);

    await expect(gate.runCloud(() => "not reached")).rejects.toThrow("presentation failed");
    expect(presentation.end).toHaveBeenCalledWith("cloud");
    expect(gate.busy).toBe(false);

    failBegin = false;
    await expect(gate.runLocal(() => "retry")).resolves.toBe("retry");
  });
});
